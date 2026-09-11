#!/usr/bin/env node
/**
 * Manual migration entry point (`npm run migrate:deploy`).
 *
 * The real implementation lives in src/migrate.ts and also runs automatically on
 * server boot; this wrapper exists for running migrations without starting the API.
 */

require('../dist/migrate')
  .runMigrations()
  .catch((err) => {
    console.error('[migrate] Migration failed:', err.message || err);
    process.exit(1);
  });
