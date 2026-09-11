import crypto from 'crypto';

/**
 * Agent credentials (PRD 7.2).
 *
 * Agents previously authenticated with the printer's own API key, which every
 * install on that printer shared. That key identified a printer, not a machine,
 * so a compromised shop PC could not be revoked without re-keying the printer
 * and breaking every other install.
 *
 * A paired agent now gets its own token. Only the SHA-256 of the token is
 * stored: the plaintext is returned once at pairing and is unrecoverable
 * afterwards, so a database disclosure does not yield usable credentials.
 */

export const DEVICE_TOKEN_PREFIX = 'dvt_';
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/** How long a device token stays valid before the agent must re-pair. */
export const DEVICE_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface IssuedDeviceToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function issueDeviceToken(now: Date = new Date()): IssuedDeviceToken {
  const token = `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
  return {
    token,
    tokenHash: hashDeviceToken(token),
    expiresAt: new Date(now.getTime() + DEVICE_TOKEN_TTL_MS),
  };
}

/**
 * Human-transcribable pairing code.
 *
 * A shop owner reads this off the dashboard and types it into the agent, so it
 * avoids characters that are easily confused by eye (0/O, 1/I/L). Short and
 * low-entropy by design, which is why it is single-use and expires in minutes.
 */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  // Grouped for readability when read aloud or typed.
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizePairingCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
}

/**
 * Constant-time comparison, so a caller cannot learn a secret by measuring how
 * long a rejection takes.
 */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export type AgentAuthMethod = 'device-token' | 'legacy-printer-key';

export interface AgentIdentity {
  printerId: string;
  shopId: string;
  deviceId?: string;
  method: AgentAuthMethod;
}

export interface AgentAuthFailure {
  status: number;
  error: string;
  /** Security event type to record for this rejection. */
  eventType: string;
}
