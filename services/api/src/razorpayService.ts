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
  /** Set when the order carries a Route split to the shop's linked account. */
  transferAmountCents?: number;
  serviceFeeCents?: number;
}

/** A Route split attached to an order at creation time. */
export interface OrderTransfer {
  account: string;
  amount: number;
  currency: 'INR';
  notes?: Record<string, string>;
  on_hold?: boolean;
}

export class RazorpayService {
  private keyId: string;
  private keySecret: string;
  private webhookSecret: string;

  constructor() {
    this.keyId = process.env.RAZORPAY_KEY_ID || '';
    this.keySecret = process.env.RAZORPAY_KEY_SECRET || '';
    this.webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'printok_webhook_secret_dev';
  }

  /**
   * Create a Razorpay Order for a print job.
   * Uses real Razorpay API if keys are provided, else falls back to mock order for dev.
   */
  /**
   * Creates a Razorpay order.
   *
   * When `transfer` is supplied the order carries a Route instruction, so
   * Razorpay settles the shop's share to its own linked account at capture and
   * PrintOk retains only the service fee. Without it, the whole amount lands in
   * the platform account and the shop must be paid out separately.
   */
  public async createOrder(
    jobId: string,
    amountInCents: number,
    transfer?: OrderTransfer
  ): Promise<RazorpayOrderResult> {
    // Guarded here as well as at the endpoint, so no future caller can send an
    // amount Razorpay will refuse.
    if (!Number.isFinite(amountInCents) || amountInCents < MIN_ORDER_AMOUNT_PAISE) {
      throw new Error(
        `A Razorpay order must be at least ${MIN_ORDER_AMOUNT_PAISE} paise; this job came to ${amountInCents}.`
      );
    }

    if (this.keyId && this.keySecret) {
      try {
        const Razorpay = require('razorpay');
        const instance = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });

        const order = await instance.orders.create({
          amount: amountInCents, // Razorpay takes amount in smallest currency unit (paise/cents)
          currency: 'INR',
          receipt: `rcpt_${jobId}`,
          notes: { jobId },
          ...(transfer ? { transfers: [transfer] } : {}),
        });

        return {
          orderId: order.id,
          amountInCents: order.amount,
          currency: order.currency,
          keyId: this.keyId,
          isSimulated: false,
          ...(transfer
            ? {
                transferAmountCents: transfer.amount,
                serviceFeeCents: amountInCents - transfer.amount,
              }
            : {}),
        };
      } catch (err: any) {
        // A simulated order in production would show the customer a checkout
        // that can never take money, so fail loudly instead.
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`Razorpay order creation failed: ${err.message}`);
        }
        console.warn('[Razorpay Service] Failed to create live order, falling back to simulated:', err.message);
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

  /** True when real Razorpay credentials are configured. */
  public get isLive(): boolean {
    return Boolean(this.keyId && this.keySecret);
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
}
