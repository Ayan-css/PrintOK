#!/usr/bin/env node
/**
 * Applies database migrations, baselining an existing database on first run.
 *
 * The production database predates Prisma Migrate, so it has the tables but no
 * _prisma_migrations history. `prisma migrate deploy` refuses that combination
 * with P3005 ("the database schema is not empty"). This script detects it and
 * records the baseline migration as already applied, so deploy then runs only
 * the migrations that genuinely change the schema.
 *
 * Behaviour by database state:
 *   * empty (a fresh Neon branch)      -> deploy creates everything
 *   * pre-Migrate with existing tables -> baseline is marked applied, then deploy
 *   * already managed by Migrate       -> deploy runs pending migrations only
 *
 * Safe to run on every boot: all three paths are idempotent.
 */

const { execFileSync } = require('child_process');

const BASELINE_MIGRATION = '20260911000000_baseline';

function runPrisma(args) {
  execFileSync('npx', ['prisma', ...args], { stdio: 'inherit' });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('[migrate] DATABASE_URL not set; skipping migrations.');
    return;
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  let hasHistory = false;
  let hasExistingSchema = false;

  try {
    const [row] = await prisma.$queryRawUnsafe(`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_history,
             to_regclass('public."Shop"')             IS NOT NULL AS has_schema
    `);
    hasHistory = Boolean(row.has_history);
    hasExistingSchema = Boolean(row.has_schema);
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

main().catch((err) => {
  console.error('[migrate] Migration failed:', err.message || err);
  // Fail the boot rather than serve application code against a schema that does
  // not match it.
  process.exit(1);
});
