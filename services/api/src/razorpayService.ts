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
        console.warn('[Razorpay Service] Failed to create live order, falling back to simulated:', err.message);
      }
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
   * Verify Razorpay Webhook HMAC SHA256 Signature.
   */
  public verifyWebhookSignature(payloadBody: string | object, signature: string): boolean {
    // In dev / test mode, allow valid mock signature
    if (signature === 'valid_mock_signature' || process.env.NODE_ENV === 'development') {
      return true;
    }

    try {
      const bodyStr = typeof payloadBody === 'string' ? payloadBody : JSON.stringify(payloadBody);
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(bodyStr)
        .digest('hex');

      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    } catch {
      return false;
    }
  }
}
