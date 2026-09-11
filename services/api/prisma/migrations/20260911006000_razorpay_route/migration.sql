-- Razorpay Route: split a customer payment so the shop's share settles directly
-- to its own linked account, instead of accumulating in the platform account
-- and being paid out manually.

ALTER TABLE "Shop"
  ADD COLUMN "razorpayAccountId"     TEXT,
  ADD COLUMN "razorpayAccountStatus" TEXT NOT NULL DEFAULT 'not_linked',
  ADD COLUMN "razorpayLinkedAt"      TIMESTAMP(3),
  ADD COLUMN "razorpayAccountError"  TEXT;

-- Per-job settlement record. Kept on the job so a payout reconciles against
-- what was actually split at the time, not against a rate that may have
-- changed since.
ALTER TABLE "PrintJob"
  ADD COLUMN "transferId"          TEXT,
  ADD COLUMN "transferAmountCents" INTEGER,
  ADD COLUMN "serviceFeeCents"     INTEGER;

CREATE INDEX "Shop_razorpayAccountId_idx" ON "Shop"("razorpayAccountId");
CREATE INDEX "PrintJob_transferId_idx"    ON "PrintJob"("transferId");
