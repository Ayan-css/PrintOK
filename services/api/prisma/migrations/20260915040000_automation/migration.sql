-- How a shop decides when a job actually reaches the printer.
--
--   after-payment  the job is queued once payment is confirmed. This is what
--                  PrintOk has always done, so it is the default and no
--                  existing shop changes behaviour.
--   all            queued the moment the order is placed, before payment
--                  clears. A shop that prints first and collects at the
--                  counter wants this; it also means printing for someone who
--                  then walks away, which is the shop's call to make.
--   off            queued only when the shop presses print. Paid jobs wait in
--                  HeldForRelease.
ALTER TABLE "ShopPortalConfig" ADD COLUMN "autoPrintMode" TEXT NOT NULL DEFAULT 'after-payment';

-- A sheet printed between jobs so a busy counter does not hand someone else's
-- pages to the wrong customer.
--
--   none     nothing between jobs
--   blank    an unmarked spacer sheet
--   invoice  a mono sheet naming the order and its token
ALTER TABLE "ShopPortalConfig" ADD COLUMN "separatorMode" TEXT NOT NULL DEFAULT 'none';

-- Only when there is a real backlog. A separator between every job in a quiet
-- hour is a sheet of wasted paper per order, which is how a shop concludes the
-- feature is not worth having.
ALTER TABLE "ShopPortalConfig" ADD COLUMN "separatorMinQueue" INTEGER NOT NULL DEFAULT 3;
