-- A way back in for a shop owner who has forgotten their password.
--
-- There was none. No reset route, no token, and no email capability to send one
-- with — so a locked-out owner lost access to their own dashboard, their queue
-- and their money, permanently, and the only remedy was an operator editing the
-- database by hand.
--
-- The token is stored as a SHA-256 and never in the clear, for the same reason
-- agent device tokens are: a leaked database must not hand out working
-- credentials. Single-use via usedAt, and short-lived via expiresAt, because a
-- reset link is a password for as long as it works.
CREATE TABLE "PasswordResetToken" (
    "tokenHash" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("tokenHash")
);

CREATE INDEX "PasswordResetToken_merchantId_idx" ON "PasswordResetToken"("merchantId");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
