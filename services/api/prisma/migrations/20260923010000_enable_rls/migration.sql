-- Close the PostgREST door: row level security on every table.
--
-- Supabase publishes every table in the `public` schema through PostgREST, so
-- with RLS disabled anyone holding the project's anon key can read and write
-- them directly at https://<project>.supabase.co/rest/v1/<Table> -- bypassing
-- the PrintOk API and every authorization check in it. Customer names, phone
-- numbers, payment references and agent credentials all live in these tables.
--
-- This is deliberately applied to ALL tables rather than only the plan ones.
-- Locking AgentRelease while PrintJob stays readable would protect the least
-- sensitive table and leave the most sensitive one open; the exposure is the
-- schema, not any one table in it.
--
-- WHY THIS DOES NOT BREAK THE API
--
-- Postgres exempts a table's OWNER from its row level security unless FORCE ROW
-- LEVEL SECURITY is also set. These tables are created by Prisma migrations
-- running as the application's own role, so that role owns them and continues
-- to read and write exactly as before. FORCE is deliberately NOT used: it would
-- apply these policies to the API itself, and with no policies defined that
-- means every query returning nothing -- a total outage, on the next deploy,
-- with no error message that says why.
--
-- NO POLICIES ARE CREATED, ON PURPOSE
--
-- RLS with no policy denies everything to every non-owner role. That is the
-- intended state: nothing except the API should be reaching these tables. A
-- permissive policy added "just to be safe" would be the hole this migration
-- exists to close.
--
-- PORTABILITY
--
-- The anon/authenticated roles exist on Supabase and not on a plain Postgres,
-- so the REVOKEs are guarded. The suite runs against a local database and this
-- migration has to be a no-op there rather than a failure.


ALTER TABLE "Shop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopPricing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopPortalConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Printer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrinterTelemetry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentPairingCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentSecurityEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminUser" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminAuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactEnquiry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MerchantUser" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrinterDailyToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordResetToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRelease" ENABLE ROW LEVEL SECURITY;

-- Prisma's own bookkeeping. Not customer data, but it is in the public schema
-- and therefore published like everything else, and it names every migration
-- this platform has ever run. Left open it would be the one table an attacker
-- could still read, which rather undoes the point.
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

-- Belt and braces: even if RLS were switched off on a table later, these roles
-- should hold no grant on it. RLS is the lock; this is not leaving the key out.
DO $$
DECLARE
  r TEXT;
  t TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['Shop','ShopPricing','ShopRate','ShopPortalConfig','Printer','PrinterTelemetry','PrintJob','JobEvent','IdempotencyRecord','AgentDevice','AgentPairingCode','AgentSecurityEvent','AdminUser','AdminAuditLog','ContactEnquiry','MerchantUser','WebhookEvent','PrinterDailyToken','PasswordResetToken','AgentRelease'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END LOOP;
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END $$;
