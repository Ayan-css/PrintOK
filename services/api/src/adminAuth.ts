import crypto from 'crypto';

/**
 * Platform operator authentication (PRD 21, 26).
 *
 * Deliberately built on Node's own crypto rather than pulling in bcrypt and a
 * JWT library: the surface needed here is small, and a password hash plus a
 * signed token is well served by scrypt and HMAC-SHA256, which ship with the
 * runtime and have no supply chain of their own.
 *
 * Passwords are never stored or logged in reversible form.
 */

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // 2^14, the Node default; deliberate CPU cost.
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

/**
 * Audience separates operator sessions from merchant sessions. Without it a
 * merchant token would verify against admin endpoints, since both are signed
 * with the same secret.
 */
export type TokenAudience = 'admin' | 'merchant';

export interface AdminTokenPayload {
  sub: string;
  email: string;
  role: string;
  aud: TokenAudience;
  /** Merchant tokens carry the shop they may act on. */
  shopId?: string;
  iat: number;
  exp: number;
}

// --------------------------------------------------------------- passwords ---

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${SCRYPT_COST}$${salt}$${derived.toString('hex')}`;
}

/**
 * Verifies a password against a stored hash in constant time.
 *
 * Returns false rather than throwing on a malformed hash, so a corrupted row
 * denies access instead of crashing the login endpoint.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, costRaw, salt, expectedHex] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !expectedHex) return false;

    const cost = Number(costRaw) || SCRYPT_COST;
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: cost });
    const expected = Buffer.from(expectedHex, 'hex');

    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Password policy. Long-but-simple beats short-but-gnarly, so this checks
 * length first and only then asks for variety.
 */
export function validatePasswordStrength(password: string): string | undefined {
  if (!password || password.length < 12) {
    return 'Password must be at least 12 characters.';
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain lower case, upper case and a digit.';
  }
  return undefined;
}

// ------------------------------------------------------------------ tokens ---

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function signingSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    // Refuse rather than silently signing admin sessions with a guessable key.
    throw new Error('JWT_SECRET is not configured (minimum 16 characters). Admin auth is disabled.');
  }
  return secret;
}

export function issueAdminToken(
  user: { id: string; email: string; role: string; shopId?: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
  audience: TokenAudience = 'admin'
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: AdminTokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    aud: audience,
    ...(user.shopId ? { shopId: user.shopId } : {}),
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', signingSecret())
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();

  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(signature)}`;
}

/**
 * Verifies a token's signature and expiry. Returns undefined for anything that
 * is not a valid, unexpired token; callers must not distinguish the reasons to
 * the client.
 */
export function verifyAdminToken(
  token: string,
  audience: TokenAudience = 'admin'
): AdminTokenPayload | undefined {
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) return undefined;

    const expected = crypto
      .createHmac('sha256', signingSecret())
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const provided = base64UrlDecode(encodedSignature);

    if (provided.length !== expected.length) return undefined;
    if (!crypto.timingSafeEqual(provided, expected)) return undefined;

    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString()) as AdminTokenPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return undefined;

    // Tokens issued for one surface must never authenticate the other.
    // Older tokens carry no audience; treat them as admin, which is what they were.
    if ((payload.aud || 'admin') !== audience) return undefined;

    return payload;
  } catch {
    return undefined;
  }
}

/** Roles permitted to change state. Support can look but not touch (PRD 24). */
export const WRITE_ROLES = new Set(['owner', 'admin']);

export function canWrite(role: string): boolean {
  return WRITE_ROLES.has(role);
}
