-- Bind a gateway payment to the job it was actually taken for.
--
-- The confirm endpoint verified Razorpay's checkout signature, which is an HMAC
-- over "<order_id>|<payment_id>" and carries no job reference, and then
-- confirmed whatever jobId the request body named. Nothing connected the two,
-- and nothing stored the gateway's order id to connect them with: PrintJob.orderId
-- is PrintOk's own customer-facing reference, not Razorpay's.
--
-- So one real one-rupee payment could be replayed against any job at any shop,
-- for any amount, without limit.
--
-- All three columns are nullable with no backfill: jobs created before this
-- migration have no gateway order recorded, and the confirm endpoint refuses
-- them rather than guessing. Those jobs are still confirmable through the
-- webhook, which reads its job reference from Razorpay-signed order notes and
-- was never affected.
ALTER TABLE "PrintJob" ADD COLUMN "razorpayOrderId" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "razorpayOrderAmountCents" INTEGER;
ALTER TABLE "PrintJob" ADD COLUMN "razorpayPaymentId" TEXT;

-- The constraint is the enforcement, not the check that precedes it: two
-- concurrent confirmations naming the same payment cannot both win, whatever
-- the application layer happens to read first.
CREATE UNIQUE INDEX "PrintJob_razorpayPaymentId_key" ON "PrintJob"("razorpayPaymentId");

-- Webhook deliveries already acted on, keyed by the gateway's own event id.
--
-- Razorpay retries until it gets a 2xx and reuses the event id when it does.
-- Idempotency was previously inferred from the job's payment state alone, which
-- conflated "have we seen this delivery" with "is this job already paid" — so a
-- refund landing between a delivery and its retry let the retry walk a refunded
-- job back to Paid, and it re-entered the shop's revenue figures.
CREATE TABLE "WebhookEvent" (
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");
