import test from 'node:test';
import assert from 'node:assert';

import { PrintState, PaymentState, FailureCategory } from '@printok/shared-types';
import { ASSIGNED_STALE_MS, PRINTING_STALE_MS } from '../jobRecovery';

/**
 * PrismaStorage integration tests.
 *
 * The in-memory suite never touched this provider, which is how the Postgres
 * path came to ignore shop rate cards and silently drop tokenNumber, isDuplex
 * and paperSize. These tests exercise the real database so that regression
 * cannot recur unnoticed.
 *
 * Requires a migrated Postgres. Run `npm run test:db`, which provisions one from
 * docker-compose. Skipped (not failed) when no database is reachable, so the
 * default `npm test` still works without Docker.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://printok_user:printok_pass@localhost:5432/printok_test';

// PrismaClient reads DATABASE_URL at construction, so point it at the test
// database before the storage module is imported.
process.env.DATABASE_URL = TEST_DATABASE_URL;
// Prisma Migrate follows directUrl. Pin it to the test database so nothing in
// this suite can ever reach the real one via the DIRECT_URL inherited from .env.
process.env.DIRECT_URL = TEST_DATABASE_URL;

// Instantiating PrismaClient loads .env, which carries real object-storage
// credentials. dotenv does not overwrite variables that are already defined, so
// blanking them here keeps S3StorageService on its local-filesystem fallback and
// stops tests from writing documents into the production bucket.
for (const key of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET_NAME']) {
  process.env[key] = '';
}

type Storage = InstanceType<typeof import('../prismaStorage').PrismaStorage>;

test('PrismaStorage (PostgreSQL) integration', async (t) => {
  let storage: Storage;

  try {
    const { PrismaStorage } = await import('../prismaStorage');
    storage = new PrismaStorage();
    // Probe connectivity before declaring subtests.
    await storage.getShop('__connectivity_probe__');
  } catch (err: any) {
    t.skip(`no test database reachable (${err?.message || err}); run \`npm run test:db\``);
    return;
  }

  const suffix = Date.now().toString(36);

  const shop = await storage.createShop(`Rate Test Shop ${suffix}`, `rates-${suffix}@example.com`);
  const printer = await storage.createPrinter(shop.id, 'Canon 2525', 'https://printok.test');

  await t.test('a shop is created with its own persisted rate card', async () => {
    const pricing = await storage.getShopPricing(shop.id);
    assert.strictEqual(pricing.bwSinglePerPageCents, 200);
    assert.strictEqual(pricing.colorSinglePerPageCents, 1000);
  });

  await t.test('rate card edits persist across reads', async () => {
    // Previously updateShopPricing returned the merged object without writing
    // it, so the merchant Rates Matrix appeared to save and then reverted.
    await storage.updateShopPricing(shop.id, {
      bwSinglePerPageCents: 500,
      bwDuplexPerPageCents: 300,
      colorSinglePerPageCents: 2500,
    });

    const reread = await storage.getShopPricing(shop.id);
    assert.strictEqual(reread.bwSinglePerPageCents, 500);
    assert.strictEqual(reread.bwDuplexPerPageCents, 300);
    assert.strictEqual(reread.colorSinglePerPageCents, 2500);
  });

  await t.test('job pricing uses the shop rate card, not hardcoded constants', async () => {
    const pdf = Buffer.from('%PDF-1.4 rate card test').toString('base64');

    const job = await storage.createPrintJob(
      printer.id, 'rates.pdf', pdf, /* pageCount */ 4, /* copies */ 2,
      /* isColor */ false, /* autoApprove */ true, /* isDuplex */ false, 'A4'
    );

    // 4 pages x 2 copies x 500 (the shop's configured B&W single rate).
    assert.strictEqual(job.totalPriceInCents, 4000);
    assert.notStrictEqual(job.totalPriceInCents, 1600, 'must not use the old hardcoded 200c rate');
  });

  await t.test('duplex rate is applied and the config is persisted', async () => {
    const pdf = Buffer.from('%PDF-1.4 duplex test').toString('base64');

    const job = await storage.createPrintJob(
      printer.id, 'duplex.pdf', pdf, 10, 1, false, true, /* isDuplex */ true, 'A4'
    );

    // 10 pages x 1 copy x 300 (configured duplex rate).
    assert.strictEqual(job.totalPriceInCents, 3000);

    // These three were dropped entirely by the previous Postgres mapping.
    const reread = await storage.getPrintJob(job.id);
    assert.strictEqual(reread!.isDuplex, true, 'isDuplex must persist');
    assert.strictEqual(reread!.paperSize, 'A4', 'paperSize must persist');
    assert.ok(reread!.tokenNumber, 'tokenNumber must persist');
    assert.ok(reread!.orderId.startsWith('ord_'), 'job must carry an order reference');
    assert.strictEqual(reread!.shopId, shop.id, 'job must be attributable to its shop');
  });

  await t.test('the price snapshot is frozen against later rate changes', async () => {
    const pdf = Buffer.from('%PDF-1.4 snapshot test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'snap.pdf', pdf, 2, 1, false, true, false, 'A4');

    const quotedTotal = job.totalPriceInCents;
    assert.ok(job.priceSnapshot, 'job must record how its price was derived');
    assert.strictEqual(job.priceSnapshot!.perPageRateCents, 500);

    // Raising rates afterwards must not restate what this customer was quoted.
    await storage.updateShopPricing(shop.id, { bwSinglePerPageCents: 9999 });

    const reread = await storage.getPrintJob(job.id);
    assert.strictEqual(reread!.totalPriceInCents, quotedTotal);
    assert.strictEqual(reread!.priceSnapshot!.perPageRateCents, 500);

    await storage.updateShopPricing(shop.id, { bwSinglePerPageCents: 500 });
  });

  await t.test('an idempotency key collapses repeated submissions', async () => {
    const pdf = Buffer.from('%PDF-1.4 idempotency test').toString('base64');
    const key = `idem_${suffix}`;

    const first = await storage.createPrintJob(
      printer.id, 'idem.pdf', pdf, 3, 1, false, true, false, 'A4', { idempotencyKey: key }
    );
    const second = await storage.createPrintJob(
      printer.id, 'idem.pdf', pdf, 3, 1, false, true, false, 'A4', { idempotencyKey: key }
    );

    assert.strictEqual(second.id, first.id, 'a replayed submission must not create a second job');
  });

  await t.test('only one device can claim a queued job', async () => {
    const pdf = Buffer.from('%PDF-1.4 claim test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'claim.pdf', pdf, 1, 1, false, true, false, 'A4');

    const first = await storage.assignJobToDevice(job.id, 'device-A');
    assert.strictEqual(first.ok, true);

    const second = await storage.assignJobToDevice(job.id, 'device-B');
    assert.strictEqual(second.ok, false, 'a second device must not claim the same job');

    const reread = await storage.getPrintJob(job.id);
    assert.strictEqual(reread!.deviceId, 'device-A');
    assert.strictEqual(reread!.printState, PrintState.Assigned);
  });

  await t.test('illegal transitions are refused and terminal states are final', async () => {
    const pdf = Buffer.from('%PDF-1.4 transition test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'fsm.pdf', pdf, 1, 1, false, true, false, 'A4');

    await storage.assignJobToDevice(job.id, 'device-A');

    const printing = await storage.updateJobPrintState(job.id, PrintState.Printing);
    assert.strictEqual(printing.ok, true);

    const completed = await storage.updateJobPrintState(job.id, PrintState.Completed);
    assert.strictEqual(completed.ok, true);

    const replay = await storage.updateJobPrintState(job.id, PrintState.Printing);
    assert.strictEqual(replay.ok, false);
    if (!replay.ok) {
      assert.strictEqual(replay.code, 'ILLEGAL_TRANSITION');
    }
  });

  await t.test('lifecycle events are recorded for every transition', async () => {
    const pdf = Buffer.from('%PDF-1.4 events test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'events.pdf', pdf, 1, 1, false, true, false, 'A4');

    await storage.assignJobToDevice(job.id, 'device-A');
    await storage.updateJobPrintState(job.id, PrintState.Printing, undefined, { actor: 'agent:device-A' });
    await storage.updateJobPrintState(job.id, PrintState.Completed, undefined, { actor: 'agent:device-A' });

    const events = await storage.getJobEvents(job.id);
    const types = events.map((e) => e.type);

    assert.ok(types.includes('JOB_CREATED'), 'creation must be recorded');
    assert.ok(types.includes('ASSIGNED'), 'assignment must be recorded');
    assert.ok(types.includes('PRINT_STATE_CHANGED'), 'transitions must be recorded');

    // Events are append-only and ordered.
    const timestamps = events.map((e) => new Date(e.createdAt).getTime());
    assert.deepStrictEqual([...timestamps].sort((a, b) => a - b), timestamps);
  });

  await t.test('completing a job purges the stored document', async () => {
    const pdf = Buffer.from('%PDF-1.4 purge test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'purge.pdf', pdf, 1, 1, false, true, false, 'A4');

    await storage.assignJobToDevice(job.id, 'device-A');
    await storage.updateJobPrintState(job.id, PrintState.Printing);
    await storage.updateJobPrintState(job.id, PrintState.Completed);

    const reread = await storage.getPrintJob(job.id);
    assert.ok(reread!.documentDeletedAt, 'document retention must be closed out on completion');
  });

  await t.test('payment confirmation queues the job without asserting it printed', async () => {
    const pdf = Buffer.from('%PDF-1.4 payment test').toString('base64');
    const job = await storage.createPrintJob(
      printer.id, 'pay.pdf', pdf, 1, 1, false, /* autoApprove */ false, false, 'A4'
    );

    assert.strictEqual(job.paymentState, PaymentState.Pending);
    assert.strictEqual(job.printState, PrintState.AwaitingPayment);

    const result = await storage.confirmPaymentAndQueueJob(job.id, { actor: 'webhook' });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.job.paymentState, PaymentState.Paid);
      assert.strictEqual(result.job.printState, PrintState.Queued, 'paid means queued, never printed');
      assert.ok(result.job.queuedAt);
    }
  });

  await t.test('device pairing is single-use and revocation is scoped', async () => {
    const code = 'TEST-' + suffix.slice(-4).toUpperCase();
    await storage.createPairingCode(printer.id, code, new Date(Date.now() + 60_000));

    const claimed = await storage.consumePairingCode(code, 'dev_one');
    assert.ok(claimed, 'a fresh code must be claimable');
    assert.strictEqual(claimed!.printerId, printer.id);

    // A second machine racing on the same code must lose.
    const reclaim = await storage.consumePairingCode(code, 'dev_two');
    assert.strictEqual(reclaim, undefined, 'a pairing code must be single use');

    const device = await storage.createAgentDevice({
      printerId: printer.id,
      deviceId: 'dev_one',
      tokenHash: 'hash_one',
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
      deviceName: 'SHOP-PC',
    });
    assert.strictEqual(device.status, 'active');

    const resolved = await storage.getActiveDeviceByTokenHash('hash_one');
    assert.strictEqual(resolved?.id, 'dev_one');

    await storage.revokeAgentDevice('dev_one', 'replaced');
    const afterRevoke = await storage.getActiveDeviceByTokenHash('hash_one');
    assert.strictEqual(afterRevoke, undefined, 'a revoked token must stop resolving');

    // The printer's own key is untouched, so other installs keep working.
    const stillThere = await storage.getPrinterByApiKey(printer.apiKey);
    assert.strictEqual(stillThere?.id, printer.id);
  });

  await t.test('an expired pairing code cannot be claimed', async () => {
    const code = 'EXPD-' + suffix.slice(-4).toUpperCase();
    await storage.createPairingCode(printer.id, code, new Date(Date.now() - 1000));

    const claimed = await storage.consumePairingCode(code, 'dev_late');
    assert.strictEqual(claimed, undefined, 'an expired code must be refused');
  });

  await t.test('an expired device token stops authenticating', async () => {
    await storage.createAgentDevice({
      printerId: printer.id,
      deviceId: 'dev_expired',
      tokenHash: 'hash_expired',
      tokenExpiresAt: new Date(Date.now() - 1000),
    });

    const resolved = await storage.getActiveDeviceByTokenHash('hash_expired');
    assert.strictEqual(resolved, undefined, 'an expired token must not authenticate');
  });

  await t.test('security events are auditable per printer', async () => {
    await storage.recordSecurityEvent({
      printerId: printer.id,
      deviceId: 'dev_one',
      type: 'AUTH_REJECTED',
      severity: 'warning',
      detail: { reason: 'test' },
    });

    const events = await storage.listSecurityEvents(printer.id, 10);
    assert.ok(events.length > 0);
    assert.ok(events.some((e) => e.type === 'AUTH_REJECTED'));
  });

  await t.test('an agent that dies before printing returns its job to the queue', async () => {
    const pdf = Buffer.from('%PDF-1.4 reclaim test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'reclaim.pdf', pdf, 1, 1, false, true, false, 'A4');

    await storage.assignJobToDevice(job.id, 'device-dead');

    // Nothing happened for longer than the Assigned threshold.
    const later = new Date(Date.now() + ASSIGNED_STALE_MS + 60_000);
    const result = await storage.reclaimStaleJobs(later);

    assert.ok(result.requeued.includes(job.id), 'an abandoned claim must be requeued');

    const reread = await storage.getPrintJob(job.id);
    assert.strictEqual(reread!.printState, PrintState.Queued);
    assert.strictEqual(reread!.deviceId, undefined, 'the dead device must release its claim');

    // And it is collectable again.
    const pending = await storage.getPendingJobsForPrinter(printer.id);
    assert.ok(pending.some((j) => j.id === job.id));
  });

  await t.test('an agent that dies WHILE printing is escalated, never reprinted', async () => {
    const pdf = Buffer.from('%PDF-1.4 ambiguous test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'ambiguous.pdf', pdf, 1, 1, false, true, false, 'A4');

    await storage.assignJobToDevice(job.id, 'device-dead');
    await storage.updateJobPrintState(job.id, PrintState.Printing);

    const later = new Date(Date.now() + PRINTING_STALE_MS + 60_000);
    const result = await storage.reclaimStaleJobs(later);

    // Paper may already have come out. Reprinting would double-charge and
    // double-print, so this must go to a human instead (PRD 11, 12).
    assert.ok(result.escalated.includes(job.id), 'an ambiguous stall must escalate');
    assert.ok(!result.requeued.includes(job.id), 'an ambiguous stall must NOT be requeued');

    const reread = await storage.getPrintJob(job.id);
    assert.strictEqual(reread!.printState, PrintState.RequiresShopAction);
    assert.strictEqual(reread!.failureCategory, FailureCategory.SafetyCritical);

    const needsAction = await storage.getJobsRequiringAction(shop.id);
    assert.ok(needsAction.some((j) => j.id === job.id), 'it must surface to the shop');
  });

  await t.test('a job still making progress is left alone', async () => {
    const pdf = Buffer.from('%PDF-1.4 healthy test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'healthy.pdf', pdf, 1, 1, false, true, false, 'A4');
    await storage.assignJobToDevice(job.id, 'device-alive');

    // Sweeping now, well inside the threshold, must not disturb it.
    const result = await storage.reclaimStaleJobs(new Date());
    assert.ok(!result.requeued.includes(job.id));
    assert.ok(!result.escalated.includes(job.id));

    const reread = await storage.getPrintJob(job.id);
    assert.strictEqual(reread!.printState, PrintState.Assigned);
  });

  await t.test('a job out of retries is escalated instead of looping forever', async () => {
    const pdf = Buffer.from('%PDF-1.4 retry test').toString('base64');
    const job = await storage.createPrintJob(printer.id, 'retry.pdf', pdf, 1, 1, false, true, false, 'A4');

    // Exhaust the attempt budget by repeatedly claiming and abandoning.
    for (let i = 0; i < 3; i++) {
      await storage.assignJobToDevice(job.id, `device-${i}`);
      await storage.reclaimStaleJobs(new Date(Date.now() + ASSIGNED_STALE_MS + 60_000));
    }

    const reread = await storage.getPrintJob(job.id);
    assert.strictEqual(
      reread!.printState,
      PrintState.RequiresShopAction,
      'a job that keeps being abandoned must stop retrying and ask for help'
    );
  });

  await t.test('a QR code can be regenerated against a corrected web URL', async () => {
    const before = await storage.getPrinter(printer.id);
    assert.ok(before!.qrTargetUrl.includes('printok.test'));

    const updated = await storage.regeneratePrinterQr(
      printer.id,
      'https://real.example.com',
      async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`
    );

    assert.ok(updated!.qrTargetUrl.startsWith('https://real.example.com/?printer='));
    assert.ok(!updated!.qrTargetUrl.includes('localhost'));

    const reread = await storage.getPrinter(printer.id);
    assert.strictEqual(reread!.qrTargetUrl, updated!.qrTargetUrl, 'the new URL must persist');
  });

  await t.test('shop stats aggregate from the database', async () => {
    const stats = await storage.getShopStats(shop.id);
    assert.strictEqual(stats.shopId, shop.id);
    assert.ok(stats.todayJobsCount > 0, 'jobs created above must be counted');
    assert.ok(stats.todayRevenueCents > 0);
  });
});
