-- Move shops onto the real plan catalogue.
--
-- The previous placeholder tiers (free/starter/pro) are renamed to the agreed
-- ones, and each shop's commission is reset to its tier's published rate so no
-- shop is left on a rate that does not match what it is shown.
--
-- Idempotent: re-running maps nothing, because the old names no longer exist.

UPDATE "Shop" SET "planTier" = 'start'    WHERE "planTier" = 'free';
UPDATE "Shop" SET "planTier" = 'smart'    WHERE "planTier" = 'starter';
UPDATE "Shop" SET "planTier" = 'business' WHERE "planTier" = 'pro';

-- Anything unrecognised falls back to the entry tier rather than being left in
-- a state the application cannot price.
UPDATE "Shop"
SET "planTier" = 'start'
WHERE "planTier" NOT IN ('start', 'smart', 'business', 'enterprise');

-- Published service fees: Start 8%, Smart 4%, Business 2%, Enterprise 0.5%.
UPDATE "Shop" SET "commissionBps" = 800 WHERE "planTier" = 'start';
UPDATE "Shop" SET "commissionBps" = 400 WHERE "planTier" = 'smart';
UPDATE "Shop" SET "commissionBps" = 200 WHERE "planTier" = 'business';
UPDATE "Shop" SET "commissionBps" = 50  WHERE "planTier" = 'enterprise';

-- New shops start on Start.
ALTER TABLE "Shop" ALTER COLUMN "planTier" SET DEFAULT 'start';
ALTER TABLE "Shop" ALTER COLUMN "commissionBps" SET DEFAULT 800;
