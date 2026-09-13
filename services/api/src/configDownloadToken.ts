import crypto from 'crypto';

/**
 * Short-lived, printer-scoped authorisation for downloading an agent's
 * appsettings.json.
 *
 * The config file carries the printer's agent API key, which is a live
 * credential. The download endpoint used to be unauthenticated, so anyone who
 * knew a printer id could fetch it — and printer ids are not secret: they are
 * encoded in the QR poster and appear in the customer URL as ?printer=<id>.
 * Scanning a shop's poster was therefore enough to obtain that shop's agent
 * credentials.
 *
 * The fix has to survive one awkward constraint: the dashboard downloads this
 * file by navigating to a URL (an <a href> / window.location), which cannot
 * carry an Authorization header. So the flow is split in two:
 *
 *   1. POST /api/printers/:id/agent-config-token   (merchant session required)
 *      mints one of these tokens, after checking the printer belongs to the
 *      caller's shop.
 *   2. GET  /api/printers/:id/agent-config?token=  exchanges it for the file.
 *
 * What that buys:
 *   * the permanent API key is never in a URL — only this token is, and it is
 *     useless two minutes later;
 *   * the token names the printer it was minted for, so a token for printer A
 *     cannot fetch printer B's config even though both are the caller's;
 *   * it is single use, so a copy left in browser history or a proxy log
 *     cannot be replayed.
 *
 * Deliberately not a JWT, and deliberately not signed with the session secret
 * directly. The signing key is derived from JWT_SECRET through a fixed label,
 * so a session token can never be presented here and one of these can never be
 * presented as a session — the two live in different key domains rather than
 * relying on an `aud` claim being checked correctly at every call site.
 */

/**
 * Two minutes: long enough for a click to become a download on a slow
 * connection, short enough that a leaked URL is worthless by the time anyone
 * reads the log it landed in.
 */
export const CONFIG_DOWNLOAD_TTL_MS = 2 * 60 * 1000;

/** Scope recorded against the single-use record, so replays are attributable. */
export const CONFIG_DOWNLOAD_SCOPE = 'agent-config-download';

const KEY_LABEL = 'printok:agent-config-download:v1';

export interface ConfigDownloadClaims {
  /** Printer this token may fetch, and only this one. */
  printerId: string;
  /** Shop that printer belonged to when the token was minted. */
  shopId: string;
  /** Merchant user who asked for it, for the audit trail. */
  issuedTo: string;
  /** Unique id, used to burn the token after one use. */
  jti: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

/**
 * Separate key domain, derived rather than shared.
 *
 * Throws when JWT_SECRET is missing or weak, matching adminAuth: refusing is
 * correct, because the alternative is signing an authorisation with a
 * guessable key.
 */
function signingKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET is not configured (minimum 16 characters). Config downloads are disabled.');
  }
  return crypto.createHmac('sha256', secret).update(KEY_LABEL).digest();
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

export interface IssuedConfigDownloadToken {
  token: string;
  jti: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

export function issueConfigDownloadToken(
  input: { printerId: string; shopId: string; issuedTo: string },
  now: Date = new Date()
): IssuedConfigDownloadToken {
  const jti = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + CONFIG_DOWNLOAD_TTL_MS);

  const claims: ConfigDownloadClaims = {
    printerId: input.printerId,
    shopId: input.shopId,
    issuedTo: input.issuedTo,
    jti,
    exp: expiresAt.getTime(),
  };

  const payload = base64Url(JSON.stringify(claims));
  const signature = base64Url(crypto.createHmac('sha256', signingKey()).update(payload).digest());

  return {
    token: `${payload}.${signature}`,
    jti,
    expiresAt,
    expiresInSeconds: Math.floor(CONFIG_DOWNLOAD_TTL_MS / 1000),
  };
}

/**
 * Verifies signature, expiry and printer binding together.
 *
 * `expectedPrinterId` is required rather than optional: making the binding
 * check the caller's responsibility is how cross-resource token reuse gets
 * shipped. Returns undefined for every failure without distinguishing them, so
 * a caller cannot turn this into an oracle.
 */
export function verifyConfigDownloadToken(
  token: string,
  expectedPrinterId: string,
  now: Date = new Date()
): ConfigDownloadClaims | undefined {
  try {
    const [payload, signature] = String(token).split('.');
    if (!payload || !signature) return undefined;

    const expected = crypto.createHmac('sha256', signingKey()).update(payload).digest();
    const provided = fromBase64Url(signature);

    if (provided.length !== expected.length) return undefined;
    if (!crypto.timingSafeEqual(provided, expected)) return undefined;

    const claims = JSON.parse(fromBase64Url(payload).toString()) as ConfigDownloadClaims;

    if (!claims.printerId || !claims.shopId || !claims.jti) return undefined;
    if (!claims.exp || claims.exp < now.getTime()) return undefined;

    // The binding that stops a valid token for one printer reading another.
    if (claims.printerId !== expectedPrinterId) return undefined;

    return claims;
  } catch {
    return undefined;
  }
}
