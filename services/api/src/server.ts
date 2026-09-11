import http from 'http';
import { createApp } from './app';
import { MemoryStorage, IStorageProvider } from './storage';
import { AgentWebSocketServer } from './ws';
import { runMigrations } from './migrate';

const PORT = process.env.PORT || 4000;

async function startServer() {
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
    storage = new MemoryStorage();
    console.log('[PrintOk] DATABASE_URL not set — using in-memory storage (data lost on restart).');
  }

  // Create HTTP server first, then WebSocket server, then Express app.
  // This ensures wsServer is available when createApp configures its routes.
  const server = http.createServer();
  const wsServer = new AgentWebSocketServer(server, storage);
  const app = createApp(storage, wsServer);

  server.on('request', app);

  server.listen(PORT, () => {
    console.log(`[PrintOk Cloud API] Listening on http://localhost:${PORT} (WS: ws://localhost:${PORT}/ws/agent)`);
  });
}

startServer().catch((err) => {
  console.error('[PrintOk] Failed to start server:', err);
  process.exit(1);
});
