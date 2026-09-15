-- Customer identity on a print job.
--
-- A merchant could see a token number and nothing else, so an uncollected
-- printout or a job that came out wrong had no route back to the person who
-- ordered it. Both fields are nullable and stay null unless the shop has asked
-- for them: collection is opt-in per shop, because the published privacy policy
-- promises anonymity by default and that promise holds for any shop that leaves
-- this switched off.
ALTER TABLE "PrintJob" ADD COLUMN "customerName" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "customerPhone" TEXT;

-- What the customer portal asks for, decided by the shop.
--
-- A separate table rather than more columns on Shop: the portal has a lot more
-- to configure than this (which services are offered, which paper sizes, photo
-- tools) and that all belongs together rather than widening Shop each time.
CREATE TABLE "ShopPortalConfig" (
    "shopId" TEXT NOT NULL,
    -- Default false on both. An existing shop keeps collecting nothing, which
    -- is what its customers were told when they placed their last order.
    "collectCustomerName" BOOLEAN NOT NULL DEFAULT false,
    "customerNameRequired" BOOLEAN NOT NULL DEFAULT false,
    "collectCustomerPhone" BOOLEAN NOT NULL DEFAULT false,
    "customerPhoneRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopPortalConfig_pkey" PRIMARY KEY ("shopId")
);

ALTER TABLE "ShopPortalConfig"
    ADD CONSTRAINT "ShopPortalConfig_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
