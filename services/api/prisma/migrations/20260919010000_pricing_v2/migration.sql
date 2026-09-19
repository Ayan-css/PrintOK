-- Pricing v2: Free / Starter / Business / Pro.
--
-- The tier id is a String column, never a Postgres enum, so renaming a tier is
-- a data update rather than enum surgery. That is the whole reason this
-- migration is safe to run against live shops.
--
-- Mapping, old -> new:
--   start      -> free      8.00% -> 2.00%
--   smart      -> starter   4.00% -> 1.00%
--   business   -> business  2.00% -> 0.50%
--   enterprise -> pro       0.50% -> 0.00%
--
-- Every shop's platform fee FALLS. This is a price cut, so it needs no consent
-- from existing shops -- but it is deliberately not silent: it should be
-- announced, and Part 7 of STATUS.md records that it has not been yet.
--
-- Historical orders are NOT restated. Each PrintJob froze the rate it was
-- charged at in commissionBpsUsed at confirmation time, and nothing here
-- touches PrintJob. That column exists for precisely this moment.

-- 1. New shops get the Free tier and its 2% fee.
ALTER TABLE "Shop" ALTER COLUMN "planTier" SET DEFAULT 'free';
ALTER TABLE "Shop" ALTER COLUMN "commissionBps" SET DEFAULT 200;

-- 2. Move the platform fee, but ONLY where the shop is still on its tier's
--    published rate. A shop whose rate an operator negotiated by hand keeps it;
--    overwriting a negotiated rate during a rename would be a silent price
--    change to a specific customer, which is exactly what must not happen.
UPDATE "Shop" SET "commissionBps" = 200 WHERE "planTier" = 'start'      AND "commissionBps" = 800;
UPDATE "Shop" SET "commissionBps" = 100 WHERE "planTier" = 'smart'      AND "commissionBps" = 400;
UPDATE "Shop" SET "commissionBps" =  50 WHERE "planTier" = 'business'   AND "commissionBps" = 200;
UPDATE "Shop" SET "commissionBps" =   0 WHERE "planTier" = 'enterprise' AND "commissionBps" =  50;

-- 3. Then rename the tiers. Order matters: the fee updates above key on the
--    OLD tier id, so renaming first would match nothing and leave every shop
--    on its old rate under a new plan name.
UPDATE "Shop" SET "planTier" = 'free'    WHERE "planTier" = 'start';
UPDATE "Shop" SET "planTier" = 'starter' WHERE "planTier" = 'smart';
UPDATE "Shop" SET "planTier" = 'pro'     WHERE "planTier" = 'enterprise';
-- 'business' keeps its id and needs no rename.
