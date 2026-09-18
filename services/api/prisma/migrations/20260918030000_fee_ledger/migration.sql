-- What each order's money actually did, recorded once.
--
-- The earnings and payout screens derived every figure on the fly from the
-- shop's *current* commission rate and a hardcoded gateway percentage. Two
-- consequences: a shop that upgraded mid-month saw last week's orders restated
-- at its new rate, and the "Razorpay fee" line was always the published
-- estimate rather than what Razorpay actually charged — which for UPI, where
-- person-to-merchant MDR is zero by statute, is very likely nothing at all.
--
-- All nullable with no backfill. Orders taken before this existed have no
-- recorded ledger, and the screens fall back to deriving them exactly as they
-- did — labelled as estimates, which they always were.
ALTER TABLE "PrintJob" ADD COLUMN "grossCents" INTEGER;
ALTER TABLE "PrintJob" ADD COLUMN "gatewayFeeCents" INTEGER;
ALTER TABLE "PrintJob" ADD COLUMN "gatewayTaxCents" INTEGER;
ALTER TABLE "PrintJob" ADD COLUMN "commissionBpsUsed" INTEGER;
ALTER TABLE "PrintJob" ADD COLUMN "routeFeeCents" INTEGER;
ALTER TABLE "PrintJob" ADD COLUMN "feesAreActual" BOOLEAN NOT NULL DEFAULT false;
