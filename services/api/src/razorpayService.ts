import crypto from 'crypto';

/**
 * Razorpay rejects an order below one rupee. Checked before the call rather
 * than after, so a shop whose rate card produces a sub-rupee job gets a clear
 * refusal instead of an opaque gateway error at the moment a customer pays.
 */
export const MIN_ORDER_AMOUNT_PAISE = 100;

export interface RazorpayOrderResult {
  orderId: string;
  amountInCents: number;
  currency: string;
  keyId: string;
  isSimulated: boolean;
}

/**
 * Who an order is for, attached to the Razorpay order's notes so the payee is
 * identifiable on the gateway's side too. Public facts only: the shop's id and
 * the name it trades under. Never contact details, bank details or anything
 * about the customer.
 */
export interface OrderPayee {
  shopId: string;
  shopName: string;
}

/** Which kind of Razorpay key is configured: its prefix, not a guess. */
export type RazorpayKeyMode = 'live' | 'test' | 'unknown' | 'none';

export function razorpayKeyMode(keyId: string): RazorpayKeyMode {
  if (!keyId) return 'none';
  if (keyId.startsWith('rzp_live_')) return 'live';
  if (keyId.startsWith('rzp_test_')) return 'test';
  return 'unknown';
}

/**
 * Why the configured keys must not take payments here, or undefined when they
 * may. In production only a live key takes real money; a test key there would
 * show customers a checkout that takes no money while printing their jobs.
 * RAZORPAY_ALLOW_TEST_KEYS=true is the explicit escape hatch for a staging
 * deployment that runs with NODE_ENV=production.
 */
export function razorpayConfigurationError(
  keyId: string, keySecret: string, env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!keyId || !keySecret) return undefined; // "not configured" is reported separately
  if (env.NODE_ENV !== 'production') return undefined;
  const mode = razorpayKeyMode(keyId);
  if (mode === 'live') return undefined;
  if (mode === 'test' && env.RAZORPAY_ALLOW_TEST_KEYS === 'true') return undefined;
  return mode === 'test'
    ? 'RAZORPAY_KEY_ID is a test key (rzp_test_) but NODE_ENV is production. Payments are refused ' +
      'until a live key (rzp_live_) is configured, or RAZORPAY_ALLOW_TEST_KEYS=true is set for a ' +
      'staging deployment.'
    : 'RAZORPAY_KEY_ID is neither a live (rzp_live_) nor a test (rzp_test_) key. Payments are refused.';
}

/**
 * Turns a Razorpay SDK rejection into something a human can act on.
 *
 * The SDK rejects with `{ statusCode, error: { code, description, reason, … } }`
 * and no `message`, so the obvious `err.message` is undefined. That is how a
 * failed payment reached customers as "Razorpay order creation failed:
 * undefined" — a message that named neither the cause nor anything to do about
 * it, and left the server logs no better off.
 */
export function describeRazorpayError(err: any): string {
  const detail = err?.error || err?.response?.error;
  const description = detail?.description;
  const code = detail?.code;
  const status = err?.statusCode || err?.status;

  if (description) {
    const prefix = [status, code].filter(Boolean).join(' ');
    return prefix ? `${description} (${prefix})` : description;
  }

  if (err?.message) return err.message;

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class RazorpayService {
  private keyId: string;
  private keySecret: string;
  private webhookSecret: string;

  /** Set when the keys present must not be used here; see razorpayConfigurationError. */
  private configurationError?: string;

  constructor() {
    this.keyId = process.env.RAZORPAY_KEY_ID || '';
    this.keySecret = process.env.RAZORPAY_KEY_SECRET || '';
    this.configurationError = razorpayConfigurationError(this.keyId, this.keySecret);
    if (this.configurationError) {
      // Logged by name only. Neither key is ever printed.
      console.error(`[Razorpay Service] ${this.configurationError}`);
    }
    // The development fallback below is a literal in a public repository, so
    // anyone can read it. Falling back to it in production would let a stranger
    // sign their own "payment captured" webhook and mark any job paid — free
    // printing for whoever noticed. Production therefore gets no fallback: the
    // secret stays empty and verifyWebhookSignature rejects everything, which
    // fails closed rather than open.
    //
    // Deliberately not a boot failure. The browser confirmation path is signed
    // with the API key secret and keeps working, so a missing webhook secret
    // costs the backstop rather than the whole service.
    const configuredWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (configuredWebhookSecret) {
      this.webhookSecret = configuredWebhookSecret;
    } else if (process.env.NODE_ENV === 'production') {
      this.webhookSecret = '';
      console.error(
        '[Razorpay Service] RAZORPAY_WEBHOOK_SECRET is not set. Every payment webhook will be ' +
        'rejected, so a customer who closes the page after paying will have their job left unpaid. ' +
        'Set it to the secret of the webhook configured for THIS Razorpay mode.'
      );
    } else {
      this.webhookSecret = 'printok_webhook_secret_dev';
    }
  }

  /**
   * Creates a Razorpay order for a print job.
   *
   * The amount is the server's job total and nothing else. The notes name the
   * job and the shop it is for, so the payee is on the gateway's record as
   * well as on the customer's screen.
   *
   * No Route split is attached here. The shop's share is transferred from the
   * captured payment instead, once Razorpay has reported the fee it actually
   * charged — see settleRouteTransfer in app.ts.
   *
   * Uses the real Razorpay API when keys are configured; outside production,
   * falls back to a simulated order.
   */
  public async createOrder(
    jobId: string,
    amountInCents: number,
    payee?: OrderPayee
  ): Promise<RazorpayOrderResult> {
    // Guarded here as well as at the endpoint, so no future caller can send an
    // amount Razorpay will refuse.
    if (!Number.isFinite(amountInCents) || amountInCents < MIN_ORDER_AMOUNT_PAISE) {
      throw new Error(
        `A Razorpay order must be at least ${MIN_ORDER_AMOUNT_PAISE} paise; this job came to ${amountInCents}.`
      );
    }

    if (this.configurationError) {
      throw new Error(`Payments are not available: ${this.configurationError}`);
    }

    if (this.keyId && this.keySecret) {
      try {
        const Razorpay = require('razorpay');
        const instance = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });

        const order = await instance.orders.create({
          amount: amountInCents, // Razorpay takes amount in smallest currency unit (paise/cents)
          currency: 'INR',
          receipt: `rcpt_${jobId}`,
          notes: {
            jobId,
            ...(payee ? { shopId: payee.shopId, shopName: payee.shopName.slice(0, 200) } : {}),
          },
        });

        return {
          orderId: order.id,
          amountInCents: order.amount,
          currency: order.currency,
          keyId: this.keyId,
          isSimulated: false,
        };
      } catch (err: any) {
        const reason = describeRazorpayError(err);

        // Always logged, whatever the environment: without this the only record
        // of why a payment failed is whatever reached the customer's screen.
        console.error('[Razorpay Service] Order creation failed:', reason);

        // A simulated order in production would show the customer a checkout
        // that can never take money, so fail loudly instead.
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`Razorpay order creation failed: ${reason}`);
        }
        console.warn('[Razorpay Service] Falling back to a simulated order.');
      }
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). Refusing to simulate a payment.'
      );
    }

    // Development / Simulated Order Fallback
    const mockOrderId = `order_sim_${crypto.randomBytes(8).toString('hex')}`;
    return {
      orderId: mockOrderId,
      amountInCents,
      currency: 'INR',
      keyId: 'rzp_test_simulated_key',
      isSimulated: true,
    };
  }

  /**
   * Refunds a captured payment in full.
   *
   * Used when a shop declines a job the customer has already paid for. The
   * amount is always the full order: a shop refusing to print has given the
   * customer nothing, so there is nothing to retain.
   *
   * Returns rather than throws, because the caller has already moved the job
   * to RefundPending and must record the outcome either way — a thrown error
   * would lose the distinction between "Razorpay refused" and "we never asked".
   */
  public async refundPayment(
    paymentId: string,
    amountInCents: number,
    notes: Record<string, string> = {},
    options: { reverseAll?: boolean } = {}
  ): Promise<
    | { ok: true; refundId: string; amountInCents: number; status: string; settled: boolean }
    | { ok: false; error: string }
  > {
    if (!this.keyId || !this.keySecret) {
      return { ok: false, error: 'Razorpay is not configured, so no refund can be issued.' };
    }
    if (this.configurationError) {
      return { ok: false, error: this.configurationError };
    }

    if (!paymentId) {
      return { ok: false, error: 'This job has no payment reference to refund against.' };
    }

    try {
      const Razorpay = require('razorpay');
      const instance = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });

      const refund = await instance.payments.refund(paymentId, {
        amount: amountInCents,
        speed: 'normal',
        notes,
        // Razorpay's documented flag for pulling a Route transfer back as part
        // of the refund. Only sent when asked for; the caller normally reverses
        // the transfer itself first so the reversal id is on record.
        ...(options.reverseAll ? { reverse_all: true } : {}),
      });

      // Razorpay refunds are asynchronous. The call returning does not mean the
      // money has moved: a refund is created as 'pending' and becomes
      // 'processed' when the bank has taken it, which can be days — and it can
      // fail. Only 'processed' means settled, and the caller must not tell the
      // customer their money is back before then.
      const status = String(refund.status || 'pending');

      return {
        ok: true,
        refundId: refund.id,
        amountInCents: refund.amount ?? amountInCents,
        status,
        settled: status === 'processed',
      };
    } catch (err: any) {
      const reason = describeRazorpayError(err);
      console.error(`[Razorpay Service] Refund of ${paymentId} failed:`, reason);
      return { ok: false, error: reason };
    }
  }

  /**
   * Asks Razorpay whether this order is really paid, and really ours.
   *
   * The checkout signature proves Razorpay issued a given (order, payment)
   * pair, but not that the money was captured — an authorised-but-uncaptured
   * payment produces a valid signature too. It also cannot prove which job the
   * order belongs to, so the order's `notes.jobId` is checked here as a second,
   * gateway-side binding independent of anything we store.
   *
   * Only called when credentials are configured. Returns rather than throws, so
   * a gateway hiccup surfaces as a refusal the customer can retry rather than a
   * 500 — and the webhook remains the backstop either way.
   */
  public async confirmOrderPaidForJob(
    orderId: string,
    jobId: string,
    expectedAmountCents: number
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const Razorpay = require('razorpay');
      const instance = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });
      const order = await instance.orders.fetch(orderId);

      if (!order) {
        return { ok: false, error: 'That payment order could not be found at the gateway.' };
      }

      // Razorpay marks an order 'paid' once the payment against it is captured.
      if (order.status !== 'paid') {
        return {
          ok: false,
          error: `The gateway has not confirmed this payment yet (order status '${order.status}'). It may still be processing.`,
        };
      }

      const notedJobId = order.notes?.jobId;
      if (notedJobId && notedJobId !== jobId) {
        return { ok: false, error: 'That payment belongs to a different order.' };
      }

      if (Number(order.amount) !== expectedAmountCents) {
        return { ok: false, error: 'The amount paid does not match this order.' };
      }

      return { ok: true };
    } catch (err: any) {
      const reason = describeRazorpayError(err);
      console.error(`[Razorpay Service] Could not verify order ${orderId}:`, reason);
      return { ok: false, error: `The payment could not be verified with the gateway: ${reason}` };
    }
  }

  /**
   * True when real Razorpay credentials are configured and may be used here.
   *
   * This used to be called `isLive` and meant only "both keys are set" — test
   * keys included. Whether the keys are live or test is `keyMode`.
   */
  public get isConfigured(): boolean {
    return Boolean(this.keyId && this.keySecret && !this.configurationError);
  }

  /** live | test | unknown | none, from the key id's prefix. Never the secret. */
  public get keyMode(): RazorpayKeyMode {
    return razorpayKeyMode(this.keyId);
  }

  public get publishableKeyId(): string {
    return this.keyId;
  }

  /**
   * Verifies a Razorpay webhook signature.
   *
   * This previously returned true for the literal string 'valid_mock_signature',
   * and for ANY signature when NODE_ENV was 'development'. That let anyone mark
   * any job as paid by posting one known string, so printing was free to anyone
   * who knew it. There is no bypass now: verification is always real.
   *
   * The HMAC must be computed over the exact bytes Razorpay sent, so callers
   * pass the raw request body. Re-serialising the parsed object would produce
   * different bytes and never match.
   */
  public verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!signature || !this.webhookSecret) return false;

    try {
      const expected = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(rawBody)
        .digest('hex');

      const provided = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expected, 'utf8');
      if (provided.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(provided, expectedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Verifies the signature Razorpay Checkout hands back to the browser after a
   * successful payment.
   *
   * Razorpay signs "<order_id>|<payment_id>" with the API key secret. Without
   * this check a customer could call our confirm endpoint themselves and get a
   * free print, so the client's claim of success is never trusted on its own.
   */
  public verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!orderId || !paymentId || !signature || !this.keySecret) return false;

    try {
      const expected = crypto
        .createHmac('sha256', this.keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const provided = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expected, 'utf8');
      if (provided.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(provided, expectedBuf);
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------- subscriptions ---

  /**
   * The Razorpay plan (plan_...) that bills a paid tier, from
   * RAZORPAY_PLAN_ID_STARTER / _BUSINESS / _PRO. Empty when not set up, which
   * the caller treats as "billing is not live" rather than guessing.
   */
  public subscriptionPlanId(tier: string): string {
    if (!this.isConfigured) return '';
    return process.env[`RAZORPAY_PLAN_ID_${tier.toUpperCase()}`] || '';
  }

  /**
   * Starts a monthly subscription and returns Razorpay's hosted checkout link.
   * `notes` travel back on every subscription webhook, which is how the shop
   * and tier are known when it activates.
   */
  public async createSubscription(
    planId: string,
    notes: { shopId: string; tier: string }
  ): Promise<{ id: string; shortUrl: string }> {
    const Razorpay = require('razorpay');
    const instance = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });
    try {
      const sub = await instance.subscriptions.create({
        plan_id: planId,
        // Razorpay requires a finite count; ten years of months is "until cancelled".
        total_count: 120,
        customer_notify: 1,
        notes,
      });
      return { id: sub.id, shortUrl: sub.short_url };
    } catch (err: any) {
      throw new Error(`Razorpay could not start the subscription: ${describeRazorpayError(err)}`);
    }
  }

  /**
   * Cancels a subscription.
   *
   * `atCycleEnd` true: Razorpay stops renewing it but it stays active until the
   * end of the period already paid for, then moves to cancelled and sends
   * subscription.cancelled — which is when the shop drops to Free. That is what
   * the Refund Policy promises a shop that cancels.
   *
   * `atCycleEnd` false: cancelled now. Used only when a replacement paid plan
   * has just activated, so the shop is not billed for two plans at once.
   *
   * The SDK sends cancel_at_cycle_end: 1 whenever its second argument is
   * truthy, so a plain boolean is passed — never an object, which would be
   * truthy even as { cancel_at_cycle_end: false }.
   */
  public async cancelSubscription(
    subscriptionId: string,
    options: { atCycleEnd: boolean }
  ): Promise<{ ok: boolean; error?: string }> {
    if (!subscriptionId || !this.isConfigured) return { ok: false, error: 'Razorpay is not configured.' };
    try {
      const Razorpay = require('razorpay');
      const instance = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });
      await instance.subscriptions.cancel(subscriptionId, options.atCycleEnd === true);
      return { ok: true };
    } catch (err: any) {
      const reason = describeRazorpayError(err);
      console.error(`[Razorpay Service] Could not cancel ${subscriptionId}:`, reason);
      return { ok: false, error: reason };
    }
  }
}
