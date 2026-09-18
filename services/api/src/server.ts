// Must come first: every import below may read configuration at module scope.
import { assertRequiredEnv } from './env';

import http from 'http';
import { createApp } from './app';
import { MemoryStorage, IStorageProvider } from './storage';
import { UNPAID_RETENTION_MINUTES, PAID_RETENTION_HOURS } from './documentRetention';
import { AgentWebSocketServer } from './ws';
import { runMigrations } from './migrate';

const PORT = process.env.PORT || 4000;

async function startServer() {
  // Say what is missing at boot, rather than as a 500 on the first request
  // that happens to need it.
  assertRequiredEnv();

  // Migrate before anything touches the database. A failure here must stop the
  // boot rather than let the API serve against a mismatched schema.
  await runMigrations();

  let storage: IStorageProvider;

  // Auto-detect: use Prisma + PostgreSQL when DATABASE_URL is configured,
  // otherwise fall back to in-memory storage for quick local dev without Docker.
  if (process.env.DATABASE_URL) {
    const { PrismaStorage } = await import('./prismaStorage');
    storage = new PrismaStorage();
    console.log('[PrintOk] Using PostgreSQL (Prisma) storage provider.');
  } else {
    // Development only: assertRequiredEnv refuses to boot production without a
    // DATABASE_URL precisely so this branch cannot be reached there.
    storage = new MemoryStorage();
    console.warn(
      '[PrintOk] DATABASE_URL not set — using in-memory storage. Every shop, job and payment ' +
      'is lost on restart. This is for local development only.'
    );
  }

  // Create HTTP server first, then WebSocket server, then Express app.
  // This ensures wsServer is available when createApp configures its routes.
  const server = http.createServer();
  const wsServer = new AgentWebSocketServer(server, storage);
  const app = createApp(storage, wsServer);

  server.on('request', app);

  // Sweep for jobs abandoned by a dead or disconnected agent (PRD 12, 13).
  // Without this, a shop PC that loses power mid-job leaves the customer's job
  // stuck outside the Queued filter forever, with no one aware of it.
  const RECLAIM_INTERVAL_MS = Number(process.env.RECLAIM_INTERVAL_MS) || 60_000;
  const reclaimTimer = setInterval(async () => {
    try {
      const { requeued, escalated } = await storage.reclaimStaleJobs();
      if (requeued.length || escalated.length) {
        console.log(
          `[PrintOk Recovery] Requeued ${requeued.length} abandoned job(s); ` +
          `escalated ${escalated.length} to shop action.`
        );
      }
    } catch (err: any) {
      // A failed sweep must never take the API down; the next tick retries.
      console.error('[PrintOk Recovery] Sweep failed:', err?.message || err);
    }

    // Documents whose job has stopped moving and will not be printed.
    //
    // Purging used to happen only on a state transition, so a job that never
    // transitioned again kept the customer's file for ever — and abandoning a
    // checkout is precisely how a job stops transitioning. Separate try/catch
    // so a storage outage cannot take the recovery sweep down with it.
    try {
      const { purged } = await storage.purgeAbandonedDocuments();
      if (purged.length) {
        console.log(`[PrintOk Retention] Purged ${purged.length} abandoned document(s).`);
      }
    } catch (err: any) {
      console.error('[PrintOk Retention] Sweep failed:', err?.message || err);
    }
  }, RECLAIM_INTERVAL_MS);

  // Do not hold the process open purely for the sweeper.
  reclaimTimer.unref();

  server.listen(PORT, () => {
    console.log(`[PrintOk Cloud API] Listening on http://localhost:${PORT} (WS: ws://localhost:${PORT}/ws/agent)`);
    console.log(`[PrintOk Recovery] Stale-job sweep every ${RECLAIM_INTERVAL_MS / 1000}s.`);
    console.log(
      `[PrintOk Retention] Unpaid documents kept ${UNPAID_RETENTION_MINUTES}m, ` +
      `paid-but-unprinted ${PAID_RETENTION_HOURS}h.`
    );
  });
}

startServer().catch((err) => {
  console.error('[PrintOk] Failed to start server:', err);
  process.exit(1);
});
