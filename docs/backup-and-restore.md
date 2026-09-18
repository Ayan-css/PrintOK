# Backup and restore

Backups exist. **Restore has never been tested**, which means the backups are
unproven rather than reliable — a backup nobody has restored from is a hope, not
a plan. This document is the procedure to test it, and the honest record of what
is and is not verified.

## What is backed up, and by whom

| What | Where | Who takes the backup | Verified? |
|---|---|---|---|
| Postgres (shops, jobs, payments, ledger) | Supabase | Supabase automatic backups | **Never restored** |
| Customer documents | S3 / Supabase Storage | Provider durability only | No separate backup — see below |
| One manual export | Local, `backups/` (gitignored) | Taken by hand, once | Not restored |

**Documents are deliberately not backed up.** They are deleted on printing and
swept by age (2h unpaid, 7d paid-but-unprinted), so a backup of them would be a
copy of customers' personal files outliving the retention promise the privacy
policy makes. Losing the object store means losing in-flight jobs, which is
recoverable by asking those customers to upload again. That is the intended
trade-off, not an oversight.

## What a restore must produce

Restoring the database alone is enough to resume trading, because every
money-bearing fact lives there:

- shops, their rate cards, portal config and payout details;
- jobs with their immutable price and config snapshots;
- the per-order fee ledger (`grossCents`, `gatewayFeeCents`, `gatewayTaxCents`,
  `commissionBpsUsed`), which is what makes past orders reconcilable;
- payment bindings (`razorpayOrderId`, `razorpayPaymentId`) and processed
  webhook event ids, which is what stops a replayed webhook re-confirming an
  order after a restore;
- agent device credentials as hashes, so paired agents keep working.

In-flight documents will be missing. Jobs referencing them move to
`RequiresShopAction` when an agent next polls, which is the correct outcome —
the shop is told, rather than the agent being handed a link to nothing.

## Testing a restore — never against production

The point of this procedure is that it is run somewhere disposable.

1. **Take a snapshot** from the Supabase dashboard, or `pg_dump` against the
   direct (session) connection — *not* the pooled one on 6543, which does not
   support the session-level locks a dump wants:

   ```
   pg_dump "$DIRECT_URL" --format=custom --file=printok-$(date +%F).dump
   ```

2. **Create an empty database** to restore into. A local one is fine:

   ```
   docker compose up -d postgres
   createdb -h 127.0.0.1 -U printok_user printok_restore_test
   ```

3. **Restore**:

   ```
   pg_restore --dbname="postgresql://printok_user:printok_pass@127.0.0.1:5432/printok_restore_test" \
     --no-owner --no-privileges printok-YYYY-MM-DD.dump
   ```

4. **Check the schema is current.** A restore of an older dump may predate
   migrations the code now expects:

   ```
   DATABASE_URL=...printok_restore_test npx prisma migrate status --schema services/api/prisma/schema.prisma
   ```

5. **Prove it with the test suite**, which is the part that turns "it restored"
   into "it works":

   ```
   TEST_DATABASE_URL=postgresql://printok_user:printok_pass@127.0.0.1:5432/printok_restore_test \
     npm run test:db --workspace=@printok/api
   ```

6. **Spot-check the money.** Pick a shop that has taken payments and confirm its
   earnings still reconcile — the fee ledger is per order and frozen, so the
   figures after a restore must match what they were before:

   ```sql
   SELECT "shopId", count(*), sum("grossCents"), sum("gatewayFeeCents")
   FROM "PrintJob" WHERE "paymentState" = 'Paid' GROUP BY "shopId" LIMIT 5;
   ```

7. **Drop the restore database.** It holds real customer names, phone numbers
   and payment references; it is not a thing to leave lying on a laptop.

   ```
   dropdb -h 127.0.0.1 -U printok_user printok_restore_test
   ```

## What is still unverified

- **No restore has ever been performed.** Steps 1–7 above have not been run.
  Until they have, the recovery time is unknown and so is whether the dump is
  complete.
- **No point-in-time recovery has been exercised**, so the actual recoverable
  window is whatever Supabase's plan provides, unconfirmed.
- **No restore runbook timing.** How long a restore takes decides whether it is
  an inconvenience or an outage, and nobody knows which this is.
