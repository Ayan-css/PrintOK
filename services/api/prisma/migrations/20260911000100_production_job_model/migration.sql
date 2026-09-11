-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Printer" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "documentDeletedAt" TIMESTAMP(3),
ADD COLUMN     "failureCategory" TEXT,
ADD COLUMN     "fileSizeBytes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "isDuplex" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "pageRange" TEXT,
ADD COLUMN     "paperSize" TEXT NOT NULL DEFAULT 'A4',
ADD COLUMN     "paymentProvider" TEXT,
ADD COLUMN     "paymentRef" TEXT,
ADD COLUMN     "priceSnapshot" JSONB,
ADD COLUMN     "printConfig" JSONB,
ADD COLUMN     "printedAt" TIMESTAMP(3),
ADD COLUMN     "queuedAt" TIMESTAMP(3),
ADD COLUMN     "shopId" TEXT,
ADD COLUMN     "tokenNumber" TEXT;


-- ---------------------------------------------------------------------------
-- Backfill before enforcing NOT NULL.
--
-- orderId and shopId are new required columns on a table that already holds
-- production rows, so they are added nullable above, populated here, and only
-- then constrained. Adding them NOT NULL directly aborts the migration.
-- ---------------------------------------------------------------------------

-- Derive a stable order reference from the existing job id.
UPDATE "PrintJob"
SET "orderId" = 'ord_' || replace("id", 'job_', '')
WHERE "orderId" IS NULL;

-- shopId is denormalised from the job's printer.
UPDATE "PrintJob" AS j
SET "shopId" = p."shopId"
FROM "Printer" AS p
WHERE p."id" = j."printerId"
  AND j."shopId" IS NULL;

-- Mirror the legacy per-page constants into the price snapshot so historical
-- jobs still explain the amount the customer was charged.
UPDATE "PrintJob"
SET "priceSnapshot" = jsonb_build_object(
      'source', 'legacy_backfill',
      'note', 'Reconstructed during the production job model migration.',
      'perPageCents', CASE WHEN "isColor" THEN 1000 ELSE 200 END,
      'pageCount', "pageCount",
      'copies', "copies",
      'totalPriceInCents', "totalPriceInCents"
    )
WHERE "priceSnapshot" IS NULL;

UPDATE "PrintJob"
SET "printConfig" = jsonb_build_object(
      'source', 'legacy_backfill',
      'pageCount', "pageCount",
      'copies', "copies",
      'isColor', "isColor",
      'isDuplex', "isDuplex",
      'paperSize', "paperSize"
    )
WHERE "printConfig" IS NULL;

-- Terminal jobs already had their stored document purged by the old cleanup path.
UPDATE "PrintJob"
SET "documentDeletedAt" = "updatedAt"
WHERE "documentDeletedAt" IS NULL
  AND "printState" IN ('Completed', 'Failed', 'Cancelled');

-- Lifecycle timestamps we can infer without guessing.
UPDATE "PrintJob" SET "completedAt" = "updatedAt" WHERE "completedAt" IS NULL AND "printState" = 'Completed';
UPDATE "PrintJob" SET "queuedAt" = "createdAt" WHERE "queuedAt" IS NULL AND "printState" <> 'AwaitingPayment';

-- Any job whose printer vanished cannot be attributed to a shop. The existing
-- printerId foreign key cascades deletes, so this should match zero rows; it is
-- here so the migration fails loudly rather than violating NOT NULL silently.
DELETE FROM "PrintJob" WHERE "shopId" IS NULL;

ALTER TABLE "PrintJob" ALTER COLUMN "orderId" SET NOT NULL;
ALTER TABLE "PrintJob" ALTER COLUMN "shopId" SET NOT NULL;

-- CreateTable
CREATE TABLE "ShopPricing" (
    "shopId" TEXT NOT NULL,
    "bwSinglePerPageCents" INTEGER NOT NULL DEFAULT 200,
    "bwDuplexPerPageCents" INTEGER NOT NULL DEFAULT 150,
    "colorSinglePerPageCents" INTEGER NOT NULL DEFAULT 1000,
    "colorDuplexPerPageCents" INTEGER NOT NULL DEFAULT 800,
    "a3Multiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "bulkDiscountThreshold" INTEGER NOT NULL DEFAULT 50,
    "bulkDiscountPercent" INTEGER NOT NULL DEFAULT 10,
    "enableSeparatorPage" BOOLEAN NOT NULL DEFAULT false,
    "separatorMinPages" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopPricing_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "PrinterTelemetry" (
    "printerId" TEXT NOT NULL,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL,
    "paperStatus" TEXT NOT NULL DEFAULT 'OK',
    "agentVersion" TEXT,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrinterTelemetry_pkey" PRIMARY KEY ("printerId")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "actor" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "PrinterTelemetry_lastHeartbeat_idx" ON "PrinterTelemetry"("lastHeartbeat");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "JobEvent_type_createdAt_idx" ON "JobEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_scope_createdAt_idx" ON "IdempotencyRecord"("scope", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "Shop_ownerEmail_idx" ON "Shop"("ownerEmail");

-- CreateIndex
CREATE INDEX "Printer_shopId_idx" ON "Printer"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintJob_orderId_key" ON "PrintJob"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintJob_idempotencyKey_key" ON "PrintJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PrintJob_printerId_printState_idx" ON "PrintJob"("printerId", "printState");

-- CreateIndex
CREATE INDEX "PrintJob_shopId_createdAt_idx" ON "PrintJob"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "PrintJob_printState_createdAt_idx" ON "PrintJob"("printState", "createdAt");

-- CreateIndex
CREATE INDEX "PrintJob_paymentRef_idx" ON "PrintJob"("paymentRef");

-- AddForeignKey
ALTER TABLE "ShopPricing" ADD CONSTRAINT "ShopPricing_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrinterTelemetry" ADD CONSTRAINT "PrinterTelemetry_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PrintJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Give every existing shop an explicit rate card row. Without this, shops keep
-- falling through to defaults and the merchant Rates Matrix stays a no-op.
INSERT INTO "ShopPricing" ("shopId")
SELECT "id" FROM "Shop"
ON CONFLICT ("shopId") DO NOTHING;
