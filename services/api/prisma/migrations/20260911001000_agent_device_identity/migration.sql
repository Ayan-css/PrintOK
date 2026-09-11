-- CreateTable
CREATE TABLE "AgentDevice" (
    "id" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "deviceName" TEXT,
    "osVersion" TEXT,
    "agentVersion" TEXT,
    "tokenHash" TEXT NOT NULL,
    "tokenIssuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPairingCode" (
    "code" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPairingCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "AgentSecurityEvent" (
    "id" TEXT NOT NULL,
    "printerId" TEXT,
    "deviceId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentDevice_tokenHash_key" ON "AgentDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentDevice_printerId_status_idx" ON "AgentDevice"("printerId", "status");

-- CreateIndex
CREATE INDEX "AgentDevice_lastSeenAt_idx" ON "AgentDevice"("lastSeenAt");

-- CreateIndex
CREATE INDEX "AgentPairingCode_printerId_expiresAt_idx" ON "AgentPairingCode"("printerId", "expiresAt");

-- CreateIndex
CREATE INDEX "AgentSecurityEvent_printerId_createdAt_idx" ON "AgentSecurityEvent"("printerId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSecurityEvent_type_createdAt_idx" ON "AgentSecurityEvent"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentDevice" ADD CONSTRAINT "AgentDevice_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

