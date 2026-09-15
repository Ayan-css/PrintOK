-- Which print services a shop offers, in the order it wants them shown.
--
-- An ordered array of capability keys rather than twenty boolean columns: the
-- catalogue grows (photo sizes, finishing, pages-per-sheet) and each addition
-- would otherwise be a migration. Order is the shop's own — the services it
-- sells most belong at the top of its customers' screen.
--
-- The keys themselves are defined in code, so an unknown key left behind by a
-- rename is ignored on read rather than breaking the portal.
ALTER TABLE "ShopPortalConfig" ADD COLUMN "enabledServices" TEXT[] NOT NULL DEFAULT '{}';

-- A shop that has never opened the setup screen still has to sell something.
-- Empty means "use the defaults", which is what the code does with it, rather
-- than meaning "this shop offers nothing".
