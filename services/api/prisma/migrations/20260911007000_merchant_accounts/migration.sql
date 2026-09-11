-- Merchant accounts.
--
-- Until now the dashboard identified a shop from browser storage alone and no
-- shop endpoint required authentication, so a shop's revenue, payout details
-- and pricing were readable and writable by anyone who knew its id.

CREATE TABLE "MerchantUser" (
    "id"           TEXT NOT NULL,
    "shopId"       TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name"         TEXT,
    "phone"        TEXT,
    "role"         TEXT NOT NULL DEFAULT 'owner',
    "status"       TEXT NOT NULL DEFAULT 'active',
    "lastLoginAt"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantUser_email_key" ON "MerchantUser"("email");
CREATE INDEX "MerchantUser_shopId_idx" ON "MerchantUser"("shopId");
CREATE INDEX "MerchantUser_email_idx"  ON "MerchantUser"("email");

ALTER TABLE "MerchantUser" ADD CONSTRAINT "MerchantUser_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
