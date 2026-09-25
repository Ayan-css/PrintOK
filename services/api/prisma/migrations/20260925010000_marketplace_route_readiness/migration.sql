-- Route readiness and merchant terms acceptance.
--
-- Additive only: every column is nullable (or has a default), so existing
-- shops, orders and payment records are untouched and read back unchanged.

-- Linked-account onboarding: the pieces Razorpay's v2 Route onboarding creates,
-- and what it still asks for.
ALTER TABLE "Shop" ADD COLUMN "razorpayStakeholderId" TEXT;
ALTER TABLE "Shop" ADD COLUMN "razorpayProductId" TEXT;
ALTER TABLE "Shop" ADD COLUMN "razorpayAccountRequirements" JSONB;
ALTER TABLE "Shop" ADD COLUMN "razorpayStatusUpdatedAt" TIMESTAMP(3);

-- Order-level payee and transfer lifecycle.
ALTER TABLE "PrintJob" ADD COLUMN "payeeAccountId" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "transferStatus" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "transferSettlementStatus" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "transferOnHold" BOOLEAN;
ALTER TABLE "PrintJob" ADD COLUMN "transferReleasedAt" TIMESTAMP(3);
ALTER TABLE "PrintJob" ADD COLUMN "transferReversalId" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "transferReversedAt" TIMESTAMP(3);
ALTER TABLE "PrintJob" ADD COLUMN "transferFailureReason" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "settledAt" TIMESTAMP(3);

-- One transfer belongs to one order, and one reversal to one transfer. Both
-- columns are null on every existing row (Route has never been on), and
-- Postgres unique indexes allow any number of nulls, so this cannot fail on
-- existing data.
DROP INDEX IF EXISTS "PrintJob_transferId_idx";
CREATE UNIQUE INDEX "PrintJob_transferId_key" ON "PrintJob"("transferId");
CREATE UNIQUE INDEX "PrintJob_transferReversalId_key" ON "PrintJob"("transferReversalId");

-- Merchant acceptance of the Terms.
ALTER TABLE "MerchantUser" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "MerchantUser" ADD COLUMN "termsVersion" TEXT;
