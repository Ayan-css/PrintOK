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

function runPrisma(args: string[]): void {
  execFileSync('npx', ['prisma', ...args, '--schema', SCHEMA_PATH], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
  });
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
