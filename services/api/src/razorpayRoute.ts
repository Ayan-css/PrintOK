import { PAYMENT_GATEWAY_FEE_BPS } from '@printok/shared-types';

/**
 * Razorpay Route — automatic split settlement to shops.
 *
 * Without Route, every customer payment lands in the PrintOk account and each
 * shop has to be paid out by hand. With Route, the order carries a transfer
 * instruction, so Razorpay settles the shop's share directly to its own linked
 * account and PrintOk keeps only the service fee.
 *
 * Two things must be true before any of this works, and neither is code:
 *   1. Route must be enabled on the PrintOk Razorpay account (Razorpay enables
 *      it on request; it is not on by default).
 *   2. Each shop must have a linked account that has passed Razorpay's KYC.
 *
 * Until both hold, `isEnabled` is false and the platform falls back to the
 * existing single-account flow. It never silently pretends a split happened.
 */

const RAZORPAY_API = 'https://api.razorpay.com/v1';

export interface LinkedAccountInput {
  shopId: string;
  shopName: string;
  ownerEmail: string;
  phone?: string;
  /** Razorpay requires a business type: individual | partnership | proprietorship | private_limited ... */
  businessType?: string;
  contactName?: string;
  /** Registered address, required by Razorpay for KYC. */
  address?: {
    street1?: string;
    street2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
}

export interface LinkedAccountResult {
  ok: boolean;
  accountId?: string;
  status?: string;
  error?: string;
  /** True when the call failed because Route is not enabled on the account. */
  routeUnavailable?: boolean;
}

export interface TransferInstruction {
  account: string;
  amount: number;
  currency: 'INR';
  notes?: Record<string, string>;
  /** Held transfers do not settle until released — used when a job may be refunded. */
  on_hold?: boolean;
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
  ): Promise<{ ok: boolean; status: number; data: any }> {
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

  /**
   * Splits an order so the shop receives everything except the PrintOk fee.
   *
   * Razorpay's own gateway fee is charged to the platform account, not deducted
   * from this transfer — so the service fee must cover it or PrintOk loses money
   * on the transaction. See `estimatePlatformMargin`.
   */
  public buildTransfer(
    shopAccountId: string,
    grossCents: number,
    commissionBps: number,
    jobId: string
  ): { transfer: TransferInstruction; serviceFeeCents: number } {
    const serviceFeeCents = Math.round((grossCents * commissionBps) / 10_000);
    const shopShareCents = Math.max(0, grossCents - serviceFeeCents);

    return {
      serviceFeeCents,
      transfer: {
        account: shopAccountId,
        amount: shopShareCents,
        currency: 'INR',
        notes: { jobId, serviceFeeCents: String(serviceFeeCents) },
      },
    };
  }

  /**
   * What PrintOk actually keeps once Razorpay has taken its cut.
   *
   * Negative means the tier's service fee does not cover the gateway fee and the
   * platform is subsidising every order on that plan.
   */
  public estimatePlatformMargin(grossCents: number, commissionBps: number): {
    serviceFeeCents: number;
    gatewayFeeCents: number;
    marginCents: number;
  } {
    const serviceFeeCents = Math.round((grossCents * commissionBps) / 10_000);
    const gatewayFeeCents = Math.round((grossCents * PAYMENT_GATEWAY_FEE_BPS) / 10_000);
    return {
      serviceFeeCents,
      gatewayFeeCents,
      marginCents: serviceFeeCents - gatewayFeeCents,
    };
  }

  /**
   * Creates a Razorpay linked account for a shop.
   *
   * Razorpay still requires the shop to complete KYC afterwards; this only
   * creates the account and returns its id and status.
   */
  public async createLinkedAccount(input: LinkedAccountInput): Promise<LinkedAccountResult> {
    if (!this.isEnabled) {
      return {
        ok: false,
        routeUnavailable: true,
        error:
          'Razorpay Route is not enabled. Set RAZORPAY_ROUTE_ENABLED=true once Razorpay has ' +
          'activated Route on the PrintOk account.',
      };
    }

    if (!input.phone) {
      return { ok: false, error: 'A contact phone number is required by Razorpay to create a linked account.' };
    }

    const payload = {
      email: input.ownerEmail,
      phone: input.phone,
      type: 'route',
      legal_business_name: input.shopName,
      business_type: input.businessType || 'proprietorship',
      contact_name: input.contactName || input.shopName,
      reference_id: input.shopId,
      profile: {
        category: 'ecommerce',
        subcategory: 'print_services',
        addresses: {
          registered: {
            street1: input.address?.street1 || '',
            street2: input.address?.street2 || '',
            city: input.address?.city || '',
            state: input.address?.state || '',
            postal_code: input.address?.postalCode || '',
            country: input.address?.country || 'IN',
          },
        },
      },
      notes: { shopId: input.shopId },
    };

    try {
      const { ok, status, data } = await this.call('POST', '/accounts', payload);

      if (!ok) {
        const message = data?.error?.description || `Razorpay returned ${status}.`;
        // Route not provisioned reads as a permission failure; distinguish it so
        // the operator is told to enable Route rather than to fix the data.
        const routeUnavailable = status === 400 && /not.*(enabled|allowed|permitted)/i.test(message);
        return { ok: false, error: message, routeUnavailable };
      }

      return { ok: true, accountId: data.id, status: data.status || 'created' };
    } catch (err: any) {
      return { ok: false, error: `Could not reach Razorpay: ${err.message}` };
    }
  }

  /** Current KYC/activation state of a linked account. */
  public async getLinkedAccount(accountId: string): Promise<LinkedAccountResult> {
    if (!this.isEnabled) {
      return { ok: false, routeUnavailable: true, error: 'Razorpay Route is not enabled.' };
    }

    try {
      const { ok, status, data } = await this.call('GET', `/accounts/${accountId}`);
      if (!ok) {
        return { ok: false, error: data?.error?.description || `Razorpay returned ${status}.` };
      }
      return { ok: true, accountId: data.id, status: data.status };
    } catch (err: any) {
      return { ok: false, error: `Could not reach Razorpay: ${err.message}` };
    }
  }

  /** Transfers already made against a payment, for reconciliation. */
  public async getPaymentTransfers(paymentId: string): Promise<{ ok: boolean; transfers: any[]; error?: string }> {
    if (!this.isEnabled) return { ok: false, transfers: [], error: 'Razorpay Route is not enabled.' };

    try {
      const { ok, data } = await this.call('GET', `/payments/${paymentId}/transfers`);
      if (!ok) return { ok: false, transfers: [], error: data?.error?.description };
      return { ok: true, transfers: data.items || [] };
    } catch (err: any) {
      return { ok: false, transfers: [], error: err.message };
    }
  }
}
