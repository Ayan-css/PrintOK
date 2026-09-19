-- Agent self-update: the record of which build the fleet is told to run.
--
-- Additive and standalone. Nothing reads this table until an operator publishes
-- a row, and with no rows every device is told it is up to date -- so applying
-- this migration changes the behaviour of exactly nothing until someone
-- deliberately publishes a release.
CREATE TABLE "AgentRelease" (
    "id"               TEXT NOT NULL,
    "version"          TEXT NOT NULL,
    "downloadUrl"      TEXT NOT NULL,
    "sha256"           TEXT NOT NULL,
    -- notify by default: the install path cannot be exercised without a Windows
    -- machine, and an untested one must not reach a fleet by default.
    "mode"             TEXT NOT NULL DEFAULT 'notify',
    "paused"           BOOLEAN NOT NULL DEFAULT false,
    "notes"            TEXT,
    "publishedBy"      TEXT,
    "publishedByEmail" TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRelease_pkey" PRIMARY KEY ("id")
);

-- The active release is the newest row, so this index serves every read.
CREATE INDEX "AgentRelease_createdAt_idx" ON "AgentRelease"("createdAt");
