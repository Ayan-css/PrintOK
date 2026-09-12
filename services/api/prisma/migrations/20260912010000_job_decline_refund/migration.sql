-- A shop can refuse a job it cannot print. Where the customer already paid,
-- that has to send the money back, so the refund is recorded against the job
-- itself: a column rather than only an event, so it reconciles against
-- Razorpay without replaying the event log.
ALTER TABLE "PrintJob" ADD COLUMN "declineReason" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "refundId" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "refundAmountCents" INTEGER;
ALTER TABLE "PrintJob" ADD COLUMN "refundedAt" TIMESTAMP(3);

CREATE INDEX "PrintJob_refundId_idx" ON "PrintJob"("refundId");
