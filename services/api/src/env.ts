import path from 'path';
import dotenv from 'dotenv';

/**
 * Loads the API's .env, and must be the first import of the entrypoint.
 *
 * Nothing used to load it. The file was only ever read as a side effect of
 * Prisma constructing a client, which meant the app's own configuration —
 * JWT_SECRET, the Razorpay keys, the pairing secret — existed only if and when
 * something happened to touch the database first, and not at all when running
 * against MemoryStorage. That is how the whole test suite ended up answering
 * 500 "JWT_SECRET is not configured" to every authenticated route.
 *
 * Resolved from this file rather than the working directory, because the host
 * decides where the process is started from and a relative path would silently
 * find nothing. Real environment variables always win: dotenv does not
 * overwrite what is already set, so a deployed process keeps the values its
 * host injected even if a .env is present in the image.
 */
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Fails the boot when a secret the app cannot work without is missing.
 *
 * These were each checked lazily at the point of use, so a missing one surfaced
 * as a 500 on whichever request first needed it — long after start-up, and
 * reported as an internal error rather than as the misconfiguration it is.
 */
export function assertRequiredEnv(): void {
  const missing: string[] = [];

  const jwt = process.env.JWT_SECRET;
  if (!jwt || jwt.length < 16) {
    missing.push('JWT_SECRET (minimum 16 characters) — sessions cannot be issued without it');
  }

  if (missing.length > 0) {
    throw new Error(
      `Refusing to start, configuration is incomplete:\n  - ${missing.join('\n  - ')}\n` +
      'Copy .env.example to services/api/.env and fill it in.'
    );
  }
}
