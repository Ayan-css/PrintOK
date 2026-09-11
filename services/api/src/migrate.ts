import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

/**
 * Applies database migrations, baselining an existing database on first run.
 *
 * This runs from the application's own boot rather than only from an npm script,
 * because the host's start command is configured outside this repository. If the
 * service is started any other way, a migration step living only in `npm start`
 * would be skipped silently and the API would serve code against a schema that
 * does not match it.
 *
 * Behaviour by database state:
 *   * empty                            -> deploy creates everything
 *   * pre-Migrate with existing tables -> baseline is marked applied, then deploy
 *   * already managed by Migrate       -> pending migrations only
 *
 * All three paths are idempotent, so this is safe to run on every boot.
 */

const BASELINE_MIGRATION = '20260911000000_baseline';

/**
 * The API package root, resolved from this file rather than from the working
 * directory. The host decides where the process is started from, and the Prisma
 * CLI resolves `prisma/schema.prisma` relative to the CWD — so a process started
 * at the repository root would not find the schema and the boot would fail.
 *
 * dist/migrate.js -> package root is one level up.
 */
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(PACKAGE_ROOT, 'prisma', 'schema.prisma');

/**
 * Migrations must never hang. A Prisma Migrate command pointed at a transaction
 * pooler blocks indefinitely on its advisory lock, and the host simply reports
 * "no open ports" many minutes later, which says nothing about the real cause.
 */
const MIGRATION_TIMEOUT_MS = 120_000;

function runPrisma(args: string[]): void {
  try {
    execFileSync('npx', ['prisma', ...args, '--schema', SCHEMA_PATH], {
      stdio: 'inherit',
      cwd: PACKAGE_ROOT,
      timeout: MIGRATION_TIMEOUT_MS,
      env: {
        ...process.env,
        // Prisma Migrate needs a direct (session) connection. Fall back to the
        // pooled URL only when no direct URL is configured.
        DIRECT_URL: process.env.DIRECT_URL || process.env.DATABASE_URL || '',
      },
    });
  } catch (err: any) {
    if (err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') {
      throw new Error(
        `prisma ${args[0]} ${args[1] ?? ''} timed out after ${MIGRATION_TIMEOUT_MS / 1000}s. ` +
        'This usually means DIRECT_URL points at a transaction pooler. Prisma Migrate needs a ' +
        'direct/session connection (Supabase: port 5432, not 6543, and no pgbouncer=true).'
      );
    }
    throw err;
  }
}

export async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('[migrate] DATABASE_URL not set; skipping migrations.');
    return;
  }

  if (process.env.PRINTOK_SKIP_MIGRATIONS === 'true') {
    console.log('[migrate] PRINTOK_SKIP_MIGRATIONS=true; skipping migrations.');
    return;
  }

  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(
      `Prisma schema not found at ${SCHEMA_PATH}. The compiled output is not laid out as expected.`
    );
  }

  // Running the API locally normally means a .env pointing at the live database,
  // and migrations run on boot — so starting the server on a developer machine
  // would silently apply pending migrations to production. Deploys set
  // NODE_ENV=production and are unaffected; anything else must opt in.
  const target = process.env.DATABASE_URL;
  const isLocalTarget = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(target);

  if (!isLocalTarget
      && process.env.NODE_ENV !== 'production'
      && process.env.PRINTOK_ALLOW_REMOTE_MIGRATE !== 'true') {
    throw new Error(
      'Refusing to migrate a remote database from a non-production process. ' +
      'DATABASE_URL does not point at localhost. Use a local database for development, ' +
      'or set PRINTOK_ALLOW_REMOTE_MIGRATE=true if this is deliberate.'
    );
  }

  const prisma = new PrismaClient();
  let hasHistory = false;
  let hasExistingSchema = false;

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ has_history: boolean; has_schema: boolean }>>(`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_history,
             to_regclass('public."Shop"')             IS NOT NULL AS has_schema
    `);
    hasHistory = Boolean(rows[0]?.has_history);
    hasExistingSchema = Boolean(rows[0]?.has_schema);
  } finally {
    await prisma.$disconnect();
  }

  if (!hasHistory && hasExistingSchema) {
    console.log(`[migrate] Existing pre-Migrate database detected. Baselining '${BASELINE_MIGRATION}'.`);
    runPrisma(['migrate', 'resolve', '--applied', BASELINE_MIGRATION]);
  }

  console.log('[migrate] Applying pending migrations...');
  runPrisma(['migrate', 'deploy']);
  console.log('[migrate] Database is up to date.');
}
