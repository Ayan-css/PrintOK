import './polyfills';
import { Readable } from 'node:stream';
import { createApp } from './app';
import { PrismaStorage } from './prismaStorage';
import { IStorageProvider, MemoryStorage } from './storage';

// ---------------------------------------------------------------------------
// Cloudflare Worker environment (secrets + vars injected per-request)
// ---------------------------------------------------------------------------
export interface CloudflareEnv {
  DATABASE_URL?: string;
  DIRECT_URL?: string;
  HYPERDRIVE?: { connectionString: string };
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

// ---------------------------------------------------------------------------
// Lazy delegating storage — Express app is created at module scope (no port
// binding needed), but the actual storage driver is only resolved on the
// first request, after syncEnv() has injected DATABASE_URL.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Express app — created once at module scope.
// NOTE: We do NOT call http.createServer — it is not supported in V8 Workers.
// Requests are bridged via fetchToExpress() below.
// ---------------------------------------------------------------------------
const app = createApp(delegatingStorage);

// ---------------------------------------------------------------------------
// Inject Cloudflare env secrets into process.env before the first storage
// access on each request.
// ---------------------------------------------------------------------------
function syncEnv(env: CloudflareEnv): void {
  if (!env) return;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
  // Hyperdrive overrides DATABASE_URL with a pooled connection string
  if (env.HYPERDRIVE?.connectionString) {
    process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
  }
}

// ---------------------------------------------------------------------------
// Minimal Fetch API ↔ Express adapter
//
// Cloudflare Workers expose only the Web Fetch API.  Express is a Node.js
// request listener (req: IncomingMessage, res: ServerResponse) => void.
// We build lightweight compatible shims using node:stream.Readable (which IS
// polyfilled by nodejs_compat) and plain objects for the response side.
// ---------------------------------------------------------------------------
function fetchToExpress(request: Request): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const url = new URL(request.url);

    // ---- Fake IncomingMessage ----
    const req = new Readable({ read() {} }) as any;
    req.method  = request.method;
    req.url     = url.pathname + (url.search ?? '');
    req.headers = {};
    request.headers.forEach((value, key) => {
      req.headers[key.toLowerCase()] = value;
    });
    // Express trust-proxy / IP detection helpers
    req.socket = { remoteAddress: '127.0.0.1', encrypted: true };
    req.connection = req.socket;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;

    // ---- Fake ServerResponse ----
    let statusCode = 200;
    const resHeaders: Record<string, string | string[]> = {};
    const chunks: Buffer[] = [];
    let resolved = false;

    function finish(extraChunk?: Buffer | string | null) {
      if (resolved) return;
      resolved = true;
      if (extraChunk != null) {
        chunks.push(Buffer.isBuffer(extraChunk) ? extraChunk : Buffer.from(String(extraChunk)));
      }
      const body   = Buffer.concat(chunks);
      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(resHeaders)) {
        hdrs[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      resolve(new Response(body.length ? body : null, { status: statusCode, headers: hdrs }));
    }

    const res: any = {
      statusCode,
      statusMessage: '',
      headersSent:   false,
      finished:      false,
      locals:        {},
      app,

      setHeader(name: string, value: string | string[]) {
        resHeaders[name.toLowerCase()] = value;
        return this;
      },
      getHeader(name: string) { return resHeaders[name.toLowerCase()]; },
      getHeaders()            { return { ...resHeaders }; },
      removeHeader(name: string) { delete resHeaders[name.toLowerCase()]; },
      hasHeader(name: string) { return name.toLowerCase() in resHeaders; },

      writeHead(status: number, msg?: string | Record<string, string>, hdrs?: Record<string, string>) {
        statusCode = status;
        this.statusCode = status;
        const extra = typeof msg === 'object' ? msg : hdrs;
        if (extra) {
          for (const [k, v] of Object.entries(extra)) {
            resHeaders[k.toLowerCase()] = v;
          }
        }
        this.headersSent = true;
        return this;
      },

      write(chunk: any, _enc?: any, cb?: () => void) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (typeof _enc === 'function') _enc();
        else if (typeof cb === 'function') cb();
        return true;
      },

      end(chunk?: any, _enc?: any, cb?: () => void) {
        this.finished = true;
        finish(chunk ?? null);
        if (typeof _enc === 'function') _enc();
        else if (typeof cb === 'function') cb();
      },

      // Express / body-parser attach listeners via on/once; we stub them
      // so the app doesn't throw on "req.socket.on is not a function" etc.
      on()   { return this; },
      once() { return this; },
      off()  { return this; },
      emit() { return false; },
      pipe() { return this; },
    };

    // Push the request body into the Readable stream, then signal EOF
    request.arrayBuffer().then((buf) => {
      if (buf.byteLength > 0) req.push(Buffer.from(buf));
      req.push(null); // EOF

      // Hand off to Express
      app(req, res, (err: any) => {
        if (err) {
          resolve(
            new Response(
              JSON.stringify({ error: err?.message ?? String(err) }),
              { status: 500, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        } else {
          resolve(new Response('Not Found', { status: 404 }));
        }
      });
    }).catch((err) => {
      resolve(
        new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Cloudflare Worker export
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: CloudflareEnv, _ctx: any): Promise<Response> {
    try {
      syncEnv(env);
      return await fetchToExpress(request);
    } catch (err: any) {
      console.error('[PrintOk Worker] Unhandled fetch error:', err);
      return new Response(
        JSON.stringify({ error: err?.message ?? String(err) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  },

  async scheduled(event: any, env: CloudflareEnv, ctx: any): Promise<void> {
    syncEnv(env);
    const storage = getStorageInstance();

    ctx.waitUntil(
      (async () => {
        try {
          const { requeued, escalated } = await storage.reclaimStaleJobs();
          if (requeued.length || escalated.length) {
            console.log(
              `[PrintOk Worker Recovery] Requeued ${requeued.length} job(s); escalated ${escalated.length} to shop action.`,
            );
          }
        } catch (err: any) {
          console.error('[PrintOk Worker Recovery] Sweep failed:', err?.message ?? err);
        }
        try {
          const { purged } = await storage.purgeAbandonedDocuments();
          if (purged.length) {
            console.log(`[PrintOk Worker Retention] Purged ${purged.length} abandoned document(s).`);
          }
        } catch (err: any) {
          console.error('[PrintOk Worker Retention] Purge failed:', err?.message ?? err);
        }
      })(),
    );
  },
};
