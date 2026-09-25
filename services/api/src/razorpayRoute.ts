import { platformFeeFor } from '@printok/shared-types';

/**
 * Razorpay Route — split settlement to shops.
 *
 * Without Route, every customer payment lands in the PrintOk account and each
 * shop has to be paid out by hand. With Route, PrintOk transfers the shop's
 * share of each captured payment to the shop's own linked account and keeps
 * only its service fee.
 *
 * Two things must be true before any of this runs, and neither is code:
 *   1. Route must be enabled on the PrintOk Razorpay account (Razorpay enables
 *      it on request; it is not on by default).
 *   2. Each shop must have a linked account whose Route product Razorpay has
 *      activated, which needs the shop's KYC.
 *
 * Until both hold, `isEnabled` is false and the platform keeps the existing
 * single-account flow. It never pretends a split happened.
 *
 * Every call here follows Razorpay's published Route API (checked 25 Sep 2026):
 *   - Linked accounts, v2: POST /v2/accounts, POST /v2/accounts/:id/stakeholders,
 *     POST /v2/accounts/:id/products, PATCH /v2/accounts/:id/products/:pid,
 *     GET /v2/accounts/:id/products/:pid.
 *   - Transfers, v1: POST /v1/payments/:id/transfers, GET /v1/payments/:id,
 *     GET /v1/payments/:id/transfers, PATCH /v1/transfers/:id,
 *     POST /v1/transfers/:id/reversals.
 */

const RAZORPAY_API = 'https://api.razorpay.com';

/**
 * Razorpay's business_type values for a linked account, as published. Anything
 * else is refused here rather than relayed as a gateway error.
 */
export const LINKED_ACCOUNT_BUSINESS_TYPES = [
  'individual', 'proprietorship', 'partnership', 'private_limited', 'public_limited',
  'llp', 'ngo', 'trust', 'society', 'not_yet_registered', 'educational_institutes', 'other',
] as const;

/**
 * The profile category Razorpay publishes for a copying and printing business.
 * Its category list has services → copying_and_blueprinting_services, which is
 * what a print or xerox shop is. Overridable, because Razorpay's reviewer may
 * classify a particular shop differently.
 */
const DEFAULT_CATEGORY = 'services';
const DEFAULT_SUBCATEGORY = 'copying_and_blueprinting_services';

export interface LinkedAccountInput {
  shopId: string;
  /** Legal name, as on the PAN or registration — not necessarily the shop sign. */
  legalBusinessName: string;
  /** The name customers know the shop by. */
  customerFacingName: string;
  email: string;
  phone: string;
  businessType: string;
  /** The person Razorpay will verify: the proprietor, partner or director. */
  contactName: string;
  address: {
    street1: string;
    street2?: string;
    city: string;
    state: string;
    postalCode: string;
    country?: string;
  };
  gstin?: string;
  /** Where Razorpay settles the shop's money. Already held for manual payouts. */
  settlement: { accountNumber: string; ifsc: string; beneficiaryName: string };
  /** The shop owner accepted Razorpay's terms for Route. */
  tncAccepted: boolean;
}

/** How far onboarding got before, so a retry resumes rather than duplicates. */
export interface OnboardingProgress {
  accountId?: string;
  stakeholderId?: string;
  productId?: string;
}

export interface LinkedAccountResult {
  ok: boolean;
  accountId?: string;
  stakeholderId?: string;
  productId?: string;
  /** Razorpay's status, verbatim — the Route product's activation_status once it exists. */
  status?: string;
  /** What Razorpay still needs, as it reported it. */
  requirements?: unknown[];
  error?: string;
  /** True when the call failed because Route is not enabled on the account. */
  routeUnavailable?: boolean;
}

/** A transfer as Razorpay describes it, reduced to what PrintOk records. */
export interface TransferSnapshot {
  id: string;
  recipient?: string;
  source?: string;
  amount?: number;
  status?: string;
  settlementStatus?: string | null;
  onHold?: boolean;
  /** Razorpay's fee for the transfer, and the GST on it, in paise. */
  feesCents?: number;
  taxCents?: number;
  notes?: Record<string, string>;
  errorDescription?: string;
}

/** The fields of a captured payment that settlement depends on. */
export interface PaymentSnapshot {
  id: string;
  status?: string;
  orderId?: string;
  amount?: number;
  /** Razorpay's fee on the payment, inclusive of GST, in paise. */
  feeCents?: number;
  taxCents?: number;
}

type CallResult = { ok: boolean; status: number; data: any };

export function toTransferSnapshot(entity: any): TransferSnapshot | undefined {
  if (!entity?.id) return undefined;
  return {
    id: String(entity.id),
    recipient: entity.recipient ?? undefined,
    source: entity.source ?? undefined,
    amount: Number.isFinite(Number(entity.amount)) ? Number(entity.amount) : undefined,
    status: entity.status ?? undefined,
    settlementStatus: entity.settlement_status ?? null,
    onHold: typeof entity.on_hold === 'boolean' ? entity.on_hold : undefined,
    feesCents: Number.isFinite(Number(entity.fees)) ? Number(entity.fees) : undefined,
    taxCents: Number.isFinite(Number(entity.tax)) ? Number(entity.tax) : undefined,
    notes: entity.notes && typeof entity.notes === 'object' && !Array.isArray(entity.notes)
      ? entity.notes : undefined,
    errorDescription: entity.error?.description ?? undefined,
  };
}

export class RazorpayRouteService {
  private keyId: string;
  private keySecret: string;

  constructor() {
    this.keyId = process.env.RAZORPAY_KEY_ID || '';
    this.keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  }

  /** Route requires credentials and an explicit opt-in, since it must be enabled by Razorpay first. */
  public get isEnabled(): boolean {
    return Boolean(this.keyId && this.keySecret && process.env.RAZORPAY_ROUTE_ENABLED === 'true');
  }

  private get authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
  }

  private async call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown
  ): Promise<CallResult> {
    const res = await fetch(`${RAZORPAY_API}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  private static describe(result: CallResult): string {
    return result.data?.error?.description || `Razorpay returned ${result.status}.`;
  }

  /**
   * Splits a captured payment into the shop's share and what PrintOk keeps.
   *
   * The shop receives the gross less PrintOk's service fee (the shop's plan
   * rate) and less the fee Razorpay *actually* charged on this payment — the
   * payment entity's `fee`, which already includes GST. That is what the
   * published terms say: gateway charges are deducted before settlement and are
   * separate from the PrintOk fee.
   *
   * The gateway fee is an input, never an estimate. It differs by payment
   * method — UPI is often nil, cards are not — so a flat published rate would
   * underpay the shop on most orders and could not be put right after the
   * transfer. That is why the transfer is made from the captured payment, when
   * the real fee is known, rather than fixed on the order beforehand.
   *
   * Razorpay's own fee for the transfer is charged to PrintOk's account and is
   * absorbed by PrintOk; it never reduces the shop's share.
   */
  public buildTransfer(
    shopAccountId: string,
    grossCents: number,
    platformFeeBps: number,
    actualGatewayFeeCents: number,
    jobId: string
  ): { transfer: { account: string; amount: number; currency: 'INR'; notes: Record<string, string>; on_hold: boolean }; serviceFeeCents: number; gatewayFeeCents: number } {
    if (!Number.isFinite(actualGatewayFeeCents) || actualGatewayFeeCents < 0) {
      throw new Error('The actual gateway fee is required to split a payment; it is never estimated.');
    }
    const serviceFeeCents = platformFeeFor(grossCents, platformFeeBps);
    const gatewayFeeCents = Math.round(actualGatewayFeeCents);
    const shopShareCents = Math.max(0, grossCents - serviceFeeCents - gatewayFeeCents);

    return {
      serviceFeeCents,
      gatewayFeeCents,
      transfer: {
        account: shopAccountId,
        amount: shopShareCents,
        currency: 'INR',
        // Held until the job prints. Released then; reversed if it is refunded
        // instead, so a shop is never paid for an order it did not fulfil.
        on_hold: true,
        notes: {
          jobId,
          serviceFeeCents: String(serviceFeeCents),
          gatewayFeeCents: String(gatewayFeeCents),
        },
      },
    };
  }

  // ------------------------------------------------------ linked accounts ---

  /**
   * Onboards a shop as a Route linked account, in Razorpay's published order:
   * account, stakeholder, Route product request, then settlement details on
   * that product. Resumes from `progress`, so a retry after a partial failure
   * does not create a second account.
   *
   * Razorpay then reviews the account and reports the product's
   * activation_status (requested → under_review / needs_clarification →
   * activated). Nothing can be transferred until it reads activated.
   */
  public async createLinkedAccount(
    input: LinkedAccountInput,
    progress: OnboardingProgress = {}
  ): Promise<LinkedAccountResult> {
    if (!this.isEnabled) {
      return {
        ok: false,
        routeUnavailable: true,
        error:
          'Razorpay Route is not enabled. Set RAZORPAY_ROUTE_ENABLED=true once Razorpay has ' +
          'activated Route on the PrintOk account.',
      };
    }

    const done: LinkedAccountResult = { ok: false, ...progress };
    const fail = (error: string, extra: Partial<LinkedAccountResult> = {}) =>
      ({ ...done, ok: false, error, ...extra });

    try {
      // 1. The linked account.
      if (!done.accountId) {
        const res = await this.call('POST', '/v2/accounts', {
          email: input.email,
          phone: input.phone,
          type: 'route',
          reference_id: input.shopId,
          legal_business_name: input.legalBusinessName,
          customer_facing_business_name: input.customerFacingName,
          business_type: input.businessType,
          contact_name: input.contactName,
          profile: {
            category: process.env.RAZORPAY_ROUTE_CATEGORY || DEFAULT_CATEGORY,
            subcategory: process.env.RAZORPAY_ROUTE_SUBCATEGORY || DEFAULT_SUBCATEGORY,
            addresses: {
              registered: {
                street1: input.address.street1,
                ...(input.address.street2 ? { street2: input.address.street2 } : {}),
                city: input.address.city,
                state: input.address.state,
                postal_code: input.address.postalCode,
                country: input.address.country || 'IN',
              },
            },
          },
          ...(input.gstin ? { legal_info: { gst: input.gstin } } : {}),
          notes: { shopId: input.shopId },
        });
        if (!res.ok) {
          const message = RazorpayRouteService.describe(res);
          // Route not provisioned reads as a permission failure; distinguish it
          // so the operator is told to enable Route rather than to fix the data.
          const routeUnavailable = /not.*(enabled|allowed|permitted)/i.test(message);
          return fail(message, { routeUnavailable });
        }
        done.accountId = res.data.id;
        done.status = res.data.status || 'created';
      }

      // 2. The person Razorpay verifies.
      if (!done.stakeholderId) {
        // Only the documented fields. Phone is optional here and its shape is
        // not something to guess at; Razorpay asks for anything further through
        // the product's requirements, which are stored and shown to the shop.
        const res = await this.call('POST', `/v2/accounts/${done.accountId}/stakeholders`, {
          name: input.contactName,
          email: input.email,
        });
        if (!res.ok) return fail(RazorpayRouteService.describe(res));
        done.stakeholderId = res.data.id;
      }

      // 3. Ask for the Route product on the account.
      if (!done.productId) {
        const res = await this.call('POST', `/v2/accounts/${done.accountId}/products`, {
          product_name: 'route',
          tnc_accepted: input.tncAccepted,
        });
        if (!res.ok) return fail(RazorpayRouteService.describe(res));
        done.productId = res.data.id;
        done.status = res.data.activation_status || done.status;
        done.requirements = Array.isArray(res.data.requirements) ? res.data.requirements : undefined;
      }

      // 4. Where Razorpay settles the shop's money.
      const res = await this.call('PATCH', `/v2/accounts/${done.accountId}/products/${done.productId}`, {
        settlements: {
          account_number: input.settlement.accountNumber,
          ifsc_code: input.settlement.ifsc,
          beneficiary_name: input.settlement.beneficiaryName,
        },
        tnc_accepted: input.tncAccepted,
      });
      if (!res.ok) return fail(RazorpayRouteService.describe(res));

      return {
        ...done,
        ok: true,
        status: res.data.activation_status || done.status,
        requirements: Array.isArray(res.data.requirements) ? res.data.requirements : done.requirements,
      };
    } catch (err: any) {
      return fail(`Could not reach Razorpay: ${err.message}`);
    }
  }

  /**
   * The linked account's Route activation status, verbatim.
   *
   * Reads the Route product configuration, whose activation_status is what
   * decides whether transfers are possible. Without a product id there is only
   * the account itself, whose status is created or suspended.
   */
  public async getLinkedAccountStatus(accountId: string, productId?: string): Promise<LinkedAccountResult> {
    if (!this.isEnabled) {
      return { ok: false, routeUnavailable: true, error: 'Razorpay Route is not enabled.' };
    }

    try {
      if (productId) {
        const res = await this.call('GET', `/v2/accounts/${accountId}/products/${productId}`);
        if (!res.ok) return { ok: false, error: RazorpayRouteService.describe(res) };
        return {
          ok: true, accountId, productId,
          status: res.data.activation_status,
          requirements: Array.isArray(res.data.requirements) ? res.data.requirements : undefined,
        };
      }
      const res = await this.call('GET', `/v2/accounts/${accountId}`);
      if (!res.ok) return { ok: false, error: RazorpayRouteService.describe(res) };
      return { ok: true, accountId, status: res.data.status };
    } catch (err: any) {
      return { ok: false, error: `Could not reach Razorpay: ${err.message}` };
    }
  }

  // ------------------------------------------------------------ transfers ---

  /** The captured payment's real figures: status, order, amount, fee and tax. */
  public async fetchPayment(paymentId: string): Promise<{ ok: true; payment: PaymentSnapshot } | { ok: false; error: string }> {
    if (!this.isEnabled) return { ok: false, error: 'Razorpay Route is not enabled.' };
    try {
      const res = await this.call('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
      if (!res.ok) return { ok: false, error: RazorpayRouteService.describe(res) };
      const p = res.data;
      return {
        ok: true,
        payment: {
          id: p.id,
          status: p.status,
          orderId: p.order_id ?? undefined,
          amount: Number(p.amount),
          feeCents: Number.isFinite(Number(p.fee)) ? Number(p.fee) : undefined,
          taxCents: Number.isFinite(Number(p.tax)) ? Number(p.tax) : undefined,
        },
      };
    } catch (err: any) {
      return { ok: false, error: `Could not reach Razorpay: ${err.message}` };
    }
  }

  /** Creates the transfer from a captured payment. The payment must be captured. */
  public async createPaymentTransfer(
    paymentId: string,
    transfer: { account: string; amount: number; currency: 'INR'; notes: Record<string, string>; on_hold: boolean }
  ): Promise<{ ok: true; transfer: TransferSnapshot } | { ok: false; error: string }> {
    if (!this.isEnabled) return { ok: false, error: 'Razorpay Route is not enabled.' };
    try {
      const res = await this.call('POST', `/v1/payments/${encodeURIComponent(paymentId)}/transfers`, {
        transfers: [{ ...transfer, linked_account_notes: ['jobId'] }],
      });
      if (!res.ok) return { ok: false, error: RazorpayRouteService.describe(res) };
      const created = toTransferSnapshot(res.data?.items?.[0]);
      if (!created) return { ok: false, error: 'Razorpay accepted the transfer but returned no transfer id.' };
      return { ok: true, transfer: created };
    } catch (err: any) {
      return { ok: false, error: `Could not reach Razorpay: ${err.message}` };
    }
  }

  /** Transfers already made against a payment, for idempotency and reconciliation. */
  public async getPaymentTransfers(paymentId: string): Promise<{ ok: boolean; transfers: TransferSnapshot[]; error?: string }> {
    if (!this.isEnabled) return { ok: false, transfers: [], error: 'Razorpay Route is not enabled.' };

    try {
      const res = await this.call('GET', `/v1/payments/${encodeURIComponent(paymentId)}/transfers`);
      if (!res.ok) return { ok: false, transfers: [], error: res.data?.error?.description };
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      return { ok: true, transfers: items.map(toTransferSnapshot).filter(Boolean) as TransferSnapshot[] };
    } catch (err: any) {
      return { ok: false, transfers: [], error: err.message };
    }
  }

  /** Releases a held transfer for settlement (on_hold: false). */
  public async releaseTransfer(transferId: string): Promise<{ ok: true; transfer?: TransferSnapshot } | { ok: false; error: string }> {
    if (!this.isEnabled) return { ok: false, error: 'Razorpay Route is not enabled.' };
    try {
      const res = await this.call('PATCH', `/v1/transfers/${encodeURIComponent(transferId)}`, { on_hold: false });
      if (!res.ok) return { ok: false, error: RazorpayRouteService.describe(res) };
      return { ok: true, transfer: toTransferSnapshot(res.data) };
    } catch (err: any) {
      return { ok: false, error: `Could not reach Razorpay: ${err.message}` };
    }
  }

  /**
   * Reverses a transfer in full, pulling the shop's share back to PrintOk's
   * account so a customer refund is not paid out of PrintOk's own money.
   * Omitting `amount` reverses the whole transfer, per Razorpay's API.
   */
  public async reverseTransfer(
    transferId: string,
    notes: Record<string, string> = {}
  ): Promise<{ ok: true; reversalId: string; amount?: number } | { ok: false; error: string }> {
    if (!this.isEnabled) return { ok: false, error: 'Razorpay Route is not enabled.' };
    try {
      const res = await this.call('POST', `/v1/transfers/${encodeURIComponent(transferId)}/reversals`, { notes });
      if (!res.ok) return { ok: false, error: RazorpayRouteService.describe(res) };
      if (!res.data?.id) return { ok: false, error: 'Razorpay returned no reversal id.' };
      return { ok: true, reversalId: res.data.id, amount: Number(res.data.amount) };
    } catch (err: any) {
      return { ok: false, error: `Could not reach Razorpay: ${err.message}` };
    }
  }
}
