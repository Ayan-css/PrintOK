#!/usr/bin/env bash
# Provisions a migrated Postgres for the PrismaStorage integration tests.
#
# Uses the docker-compose Postgres from the repo root. Safe to re-run: the test
# database is dropped and recreated each time, and it is never the dev database.
set -euo pipefail

CONTAINER="${PRINTOK_PG_CONTAINER:-printok-postgres}"
DB_NAME="${PRINTOK_TEST_DB:-printok_test}"
DB_USER="${PRINTOK_TEST_USER:-printok_user}"
DB_PASS="${PRINTOK_TEST_PASS:-printok_pass}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Postgres container '$CONTAINER' is not running. Start it with: docker compose up -d postgres" >&2
  exit 1
fi

echo "Recreating test database '$DB_NAME'..."
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null

export DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
echo "Applying migrations..."
npx prisma migrate deploy

echo "Test database ready: $DATABASE_URL"
