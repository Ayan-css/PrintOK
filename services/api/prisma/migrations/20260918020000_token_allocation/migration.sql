-- Allocate counter tokens atomically instead of inferring them from a count.
--
-- getNextTokenNumber did `SELECT COUNT(*)` over the day's jobs for a printer
-- and used count+1, with no transaction and no constraint. Two customers
-- submitting at the same printer in the same moment both read the same count
-- and both received #007 — and the token is what a shop calls out when handing
-- documents over the counter, so the wrong customer collects someone else's
-- printout.
--
-- A row per printer per day, incremented in one statement, so the database
-- hands out the number rather than the application guessing it.
CREATE TABLE "PrinterDailyToken" (
    "printerId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrinterDailyToken_pkey" PRIMARY KEY ("printerId","day")
);

-- Which day a job's token belongs to. Tokens restart every morning, so
-- "printer + token" is not unique on its own: #001 exists once a day. With the
-- day it is, and the uniqueness becomes something the database enforces rather
-- than something the application is trusted to get right.
ALTER TABLE "PrintJob" ADD COLUMN "tokenDay" TEXT;

-- Existing rows are left NULL rather than backfilled. Postgres treats NULLs as
-- distinct in a unique index, so historical jobs neither collide with each
-- other nor block the constraint, and every job created from here carries its
-- day. Backfilling would mean inventing a day for tokens issued before this
-- column existed, and two old jobs that genuinely shared a token would then
-- fail the migration.
CREATE UNIQUE INDEX "PrintJob_printerId_tokenDay_tokenNumber_key"
    ON "PrintJob"("printerId", "tokenDay", "tokenNumber");
