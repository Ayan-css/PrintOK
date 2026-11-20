import './polyfills';
import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './app';
import { IStorageProvider, MemoryStorage } from './storage';

export interface CloudflareEnv {
  DATABASE_URL?: string;
  DIRECT_URL?: string;
  HYPERDRIVE?: {
    connectionString: string;
  };
  S3_ENDPOINT?: string;
  S3_BUCKET_NAME?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  JWT_SECRET?: string;
  AGENT_PAIRING_SECRET?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  OPERATOR_EMAIL?: string;
  PUBLIC_WEB_URL?: string;
  ALLOWED_ORIGINS?: string;
  [key: string]: any;
}

let cachedHandler: any = null;
let cachedStorage: IStorageProvider | null = null;

function syncEnv(env: CloudflareEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && !process.env[key]) {
      process.env[key] = value;
    }
  }

  // If Hyperdrive is configured, route DATABASE_URL through its pooled connection
  if (env.HYPERDRIVE?.connectionString) {
    process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
  }
}

async function getStorage(): Promise<IStorageProvider> {
  if (cachedStorage) return cachedStorage;

  if (process.env.DATABASE_URL) {
    const { PrismaStorage } = await import('./prismaStorage');
    cachedStorage = new PrismaStorage();
    console.log('[PrintOk Worker] Using PostgreSQL (Prisma) storage provider.');
  } else {
    cachedStorage = new MemoryStorage();
    console.warn('[PrintOk Worker] DATABASE_URL not set — using in-memory storage fallback.');
  }

  return cachedStorage;
}

async function getHandler(env: CloudflareEnv): Promise<any> {
  if (cachedHandler) return cachedHandler;

  syncEnv(env);
  const storage = await getStorage();
  const app = createApp(storage);

  const server = createServer(app);
  server.listen(3000);

  cachedHandler = httpServerHandler(server);
  return cachedHandler;
}

export default {
  /**
   * Handle incoming HTTP requests via Cloudflare Workers
   */
  async fetch(request: any, env: CloudflareEnv, ctx: any): Promise<any> {
    const handler = await getHandler(env);
    return handler.fetch(request, env, ctx);
  },

  /**
   * Cron Trigger: Automatically sweeps stale jobs and purges abandoned documents.
   * Runs every minute (configured via `wrangler.jsonc` crons trigger).
   */
  async scheduled(event: any, env: CloudflareEnv, ctx: any): Promise<void> {
    syncEnv(env);
    const storage = await getStorage();

    ctx.waitUntil(
      (async () => {
        try {
          const { requeued, escalated } = await storage.reclaimStaleJobs();
          if (requeued.length || escalated.length) {
            console.log(
              `[PrintOk Worker Recovery] Requeued ${requeued.length} abandoned job(s); ` +
              `escalated ${escalated.length} to shop action.`
            );
          }
        } catch (err: any) {
          console.error('[PrintOk Worker Recovery] Sweep failed:', err?.message || err);
        }

        try {
          const { purged } = await storage.purgeAbandonedDocuments();
          if (purged.length) {
            console.log(`[PrintOk Worker Retention] Purged ${purged.length} abandoned document(s).`);
          }
        } catch (err: any) {
          console.error('[PrintOk Worker Retention] Purge failed:', err?.message || err);
        }
      })()
    );
  },
};
