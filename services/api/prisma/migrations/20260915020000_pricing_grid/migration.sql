-- A rate per print configuration, replacing four global rates and a multiplier.
--
-- The old model priced every A4 job from one of four numbers and derived A3 by
-- multiplying. A shop that charges the same for A3 colour as A4 colour, or that
-- wants Letter cheaper than A4, could not say so. One row per combination can.
CREATE TABLE "ShopRate" (
    "id"                          TEXT NOT NULL,
    "shopId"                      TEXT NOT NULL,
    "paperSize"                   TEXT NOT NULL,
    "isColor"                     BOOLEAN NOT NULL,
    "isDuplex"                    BOOLEAN NOT NULL,
    "perPageCents"                INTEGER NOT NULL,
    -- Null means this configuration has no discounted rate, which is different
    -- from having one of zero: the first is "charge the normal price", the
    -- second is "give it away".
    "bulkPerPageCents"            INTEGER,
    "additionalCopyPerPageCents"  INTEGER,
    -- Whether a customer may pick this combination at all. A shop with a
    -- mono-only printer turns colour off here rather than being asked to price
    -- something it cannot produce.
    "enabled"                     BOOLEAN NOT NULL DEFAULT true,
    "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopRate_shopId_paperSize_isColor_isDuplex_key"
    ON "ShopRate"("shopId", "paperSize", "isColor", "isDuplex");
CREATE INDEX "ShopRate_shopId_idx" ON "ShopRate"("shopId");

ALTER TABLE "ShopRate"
    ADD CONSTRAINT "ShopRate_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Discount switches live with the rest of the rate card.
--
-- The old bulk discount triggered on sheet count and took a percentage off the
-- whole subtotal. The new one triggers on order value and swaps in a different
-- per-page rate, which is what a shop actually negotiates ("over ₹100 I'll do
-- it at ₹1.20 a page"). Seeding below keeps existing shops whole.
ALTER TABLE "ShopPricing" ADD COLUMN "bulkEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopPricing" ADD COLUMN "bulkThresholdCents" INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE "ShopPricing" ADD COLUMN "additionalCopyEnabled" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- seeding ---
-- Reproduce every shop's current prices exactly. A pricing migration that
-- quietly moves what a customer is charged is the worst kind of silent bug, so
-- the base grid is derived from the very numbers the old calculator used:
-- the four rates as-is for A4 and Letter, and rounded by the A3 multiplier for
-- A3 — which is precisely what pricing.ts did at request time.
INSERT INTO "ShopRate" ("id", "shopId", "paperSize", "isColor", "isDuplex", "perPageCents", "bulkPerPageCents")
SELECT
    p."shopId" || '_' || paper.size || '_' || (CASE WHEN colour.is_color THEN 'c' ELSE 'b' END) || (CASE WHEN sided.is_duplex THEN 'd' ELSE 's' END),
    p."shopId",
    paper.size,
    colour.is_color,
    sided.is_duplex,
    base.rate,
    -- The old discount was a flat percentage off the subtotal. As a per-page
    -- rate that is the same arithmetic, so a qualifying order costs the same.
    ROUND(base.rate * (100 - p."bulkDiscountPercent") / 100.0)
FROM "ShopPricing" p
CROSS JOIN (VALUES ('A4'), ('A3'), ('Letter')) AS paper(size)
CROSS JOIN (VALUES (true), (false)) AS colour(is_color)
CROSS JOIN (VALUES (true), (false)) AS sided(is_duplex)
CROSS JOIN LATERAL (
    SELECT ROUND(
        (CASE
            WHEN colour.is_color AND sided.is_duplex     THEN p."colorDuplexPerPageCents"
            WHEN colour.is_color AND NOT sided.is_duplex THEN p."colorSinglePerPageCents"
            WHEN sided.is_duplex                         THEN p."bwDuplexPerPageCents"
            ELSE                                              p."bwSinglePerPageCents"
        END)
        * (CASE WHEN paper.size = 'A3' THEN p."a3Multiplier" ELSE 1 END)
    )::int AS rate
) AS base;

-- Carry the existing discount forward rather than dropping it. Every shop had
-- one on by default, and switching it off here would raise prices for exactly
-- the bulk customers it was meant to attract.
--
-- The trigger changes shape: it was "this many sheets", it is now "this much
-- money". Converting through the shop's *cheapest* rate is what makes that safe.
--
-- Use any dearer rate and the cheapest configurations stop qualifying: a
-- 50-sheet double-sided mono job is worth ₹75, so a threshold derived from the
-- ₹2 single-sided rate would put ₹100 in its way and raise the price of an
-- order that was discounted yesterday. Derived from the cheapest rate, every
-- configuration reaches the threshold at or before the sheet count it used to,
-- so no customer pays more than they did.
UPDATE "ShopPricing" p
SET "bulkEnabled" = true,
    "bulkThresholdCents" = GREATEST(1, p."bulkDiscountThreshold" * COALESCE(
        (SELECT MIN(r."perPageCents") FROM "ShopRate" r WHERE r."shopId" = p."shopId"),
        p."bwSinglePerPageCents"
    ))
WHERE p."bulkDiscountPercent" > 0 AND p."bulkDiscountThreshold" > 0;
