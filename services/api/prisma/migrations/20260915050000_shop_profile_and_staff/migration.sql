-- GST registration number, for shops that have one.
--
-- Nullable and unvalidated beyond its shape: a shop that is not registered has
-- no number, and refusing a legitimate one because a checksum implementation
-- disagrees is worse than storing what the owner typed off their certificate.
ALTER TABLE "Shop" ADD COLUMN "gstin" TEXT;
