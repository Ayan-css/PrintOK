import type { CorsOptions } from 'cors';

/**
 * Which browser origins may call this API.
 *
 * It was `cors()` with no arguments, which sends
 * `Access-Control-Allow-Origin: *` to everyone — so any page on the internet
 * could script requests against this API from a visitor's browser. Bearer
 * tokens are not attached automatically the way cookies are, which is the only
 * reason that was not immediately exploitable; it still meant an attacker's
 * page could freely probe endpoints and read anything unauthenticated.
 *
 * Three things this must not break, all of which the naive fix does:
 *
 *   1. **Requests with no Origin header.** The Windows print agent, Razorpay's
 *      webhooks, Render's health checks and curl all send none. They are not
 *      browser requests, CORS does not apply to them, and rejecting them would
 *      stop every shop printing.
 *   2. **Vercel preview deployments.** Their hostnames are generated per
 *      deploy, so they cannot be listed — they are matched by shape instead.
 *   3. **Local development**, on whatever port the dev server picked.
 *
 * ALLOWED_ORIGINS adds more at runtime, comma separated, so a new frontend
 * domain can be allowed without waiting for a deploy.
 */

/** Frontend origins that are always allowed. */
const DEFAULT_ORIGINS = [
  'https://printok.vercel.app',
  // Kept alongside the new domain: QR posters already printed and stuck to
  // shop counters encode this host, and those must keep working.
  'https://print-ok-customer-web.vercel.app',
];

/**
 * Vercel preview and branch deployments of this project.
 *
 * Anchored at both ends and restricted to this project's prefixes, so it
 * cannot be satisfied by an attacker registering, say,
 * `printok.vercel.app.evil.com`.
 */
const VERCEL_PREVIEW = /^https:\/\/(printok|print-ok-customer)[a-z0-9-]*\.vercel\.app$/;

const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function allowedOrigins(): string[] {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return [...new Set([...DEFAULT_ORIGINS, ...configured])];
}

/** Whether one origin may call the API. Exported so it can be tested directly. */
export function isOriginAllowed(origin: string | undefined): boolean {
  // Not a browser request. CORS is a browser policy; there is nothing to
  // protect here and plenty to break.
  if (!origin) return true;

  if (allowedOrigins().includes(origin)) return true;
  if (VERCEL_PREVIEW.test(origin)) return true;
  if (LOCALHOST.test(origin)) return true;

  return false;
}

export function corsOptions(): CorsOptions {
  return {
    origin(origin, callback) {
      // `false` rather than an Error: the request still completes, it simply
      // carries no Access-Control-Allow-Origin, so the browser refuses to hand
      // the response to the page. Passing an Error would answer 500 and make a
      // blocked origin look like a broken API.
      callback(null, isOriginAllowed(origin));
    },
    // Authentication is a Bearer token the page attaches deliberately, never a
    // cookie the browser attaches for it, so credentialed cross-origin requests
    // are not needed — and allowing them would rule out ever using a wildcard.
    credentials: false,
  };
}
