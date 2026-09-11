import crypto from 'crypto';

export interface RazorpayOrderResult {
  orderId: string;
  amountInCents: number;
  currency: string;
  keyId: string;
  isSimulated: boolean;
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
  public async createOrder(jobId: string, amountInCents: number): Promise<RazorpayOrderResult> {
    if (this.keyId && this.keySecret) {
      try {
        const Razorpay = require('razorpay');
        const instance = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });
        
        const order = await instance.orders.create({
          amount: amountInCents, // Razorpay takes amount in smallest currency unit (paise/cents)
          currency: 'INR',
          receipt: `rcpt_${jobId}`,
          notes: { jobId },
        });

        return {
          orderId: order.id,
          amountInCents: order.amount,
          currency: order.currency,
          keyId: this.keyId,
          isSimulated: false,
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
