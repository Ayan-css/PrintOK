import './polyfills';
import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './app';
import { PrismaStorage } from './prismaStorage';
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

// Lazy delegating storage provider so Express and server can be initialized
// synchronously at module scope while allowing runtime DATABASE_URL injection
let actualStorage: IStorageProvider | null = null;

function getStorageInstance(): IStorageProvider {
  if (!actualStorage) {
    if (process.env.DATABASE_URL) {
      actualStorage = new PrismaStorage();
      console.log('[PrintOk Worker] Using PostgreSQL (Prisma) storage provider.');
    } else {
      actualStorage = new MemoryStorage();
      console.warn('[PrintOk Worker] DATABASE_URL not set — using in-memory storage fallback.');
    }
  }
  return actualStorage;
}

const delegatingStorage: IStorageProvider = new Proxy({} as IStorageProvider, {
  get(_target, prop) {
    const instance = getStorageInstance() as any;
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});

// Initialize Express app and bind virtual internal port at module scope
const app = createApp(delegatingStorage);
const server = createServer(app);
server.listen(8080);

const nodeHttpHandler = httpServerHandler({ port: 8080 });

function syncEnv(env: CloudflareEnv): void {
  if (!env) return;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
  if (env.HYPERDRIVE?.connectionString) {
    process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
  }
}

export default {
  /**
   * Handle incoming HTTP requests via Cloudflare Workers
   */
  async fetch(request: any, env: CloudflareEnv, ctx: any): Promise<any> {
    try {
      syncEnv(env);
      return await nodeHttpHandler.fetch(request, env, ctx);
    } catch (err: any) {
      console.error('[PrintOk Worker Fetch Error]', err);
      return new Response(
        JSON.stringify({
          error: err?.message || String(err),
          stack: err?.stack,
        }, null, 2),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },

  /**
   * Cron Trigger: Automatically sweeps stale jobs and purges abandoned documents.
   * Runs every minute (configured via `wrangler.jsonc` crons trigger).
   */
  async scheduled(event: any, env: CloudflareEnv, ctx: any): Promise<void> {
    syncEnv(env);
    const storage = getStorageInstance();

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
