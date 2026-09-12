-- Razorpay refuses to create a Route linked account without a contact phone
-- number, and stalls KYC on an incomplete registered address. Collected at
-- signup so a shop is not chased for it at the moment it is trying to get paid.
ALTER TABLE "Shop" ADD COLUMN "contactPhone" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressStreet1" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressStreet2" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressCity" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressState" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressPostalCode" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressCountry" TEXT DEFAULT 'IN';
