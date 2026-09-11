-- Baseline of the schema as it existed before migrations were introduced.
--
-- The production database predates Prisma Migrate and therefore has no
-- _prisma_migrations table, so the very first `migrate deploy` would try to
-- create tables that already exist. Every statement here is written to be
-- idempotent, making this migration a no-op against the existing database and a
-- normal create against a fresh one (e.g. a new Neon branch).

-- CreateTable
CREATE TABLE IF NOT EXISTS "Shop" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "upiId" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "payoutStatus" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Printer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "printerName" TEXT NOT NULL,
    "qrTargetUrl" TEXT NOT NULL,
    "qrCodeDataUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'online',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PrintJob" (
    "id" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "s3Key" TEXT,
    "fileUrl" TEXT NOT NULL,
    "fileChecksum" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "copies" INTEGER NOT NULL,
    "isColor" BOOLEAN NOT NULL,
    "totalPriceInCents" INTEGER NOT NULL,
    "paymentState" TEXT NOT NULL,
    "printState" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Printer_apiKey_key" ON "Printer"("apiKey");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Printer_shopId_fkey'
  ) THEN
    ALTER TABLE "Printer" ADD CONSTRAINT "Printer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PrintJob_printerId_fkey'
  ) THEN
    ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

