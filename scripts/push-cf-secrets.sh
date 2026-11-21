#!/usr/bin/env bash
# push-cf-secrets.sh
# Reads production secrets from services/api/.env (or root .env) and uploads
# them to Cloudflare Workers via `wrangler secret put`.
#
# Usage:
#   bash scripts/push-cf-secrets.sh
#
# The script reads the FIRST uncommented value for each key, so if your .env
# has a local value active and a remote value commented out, uncomment the
# remote one first (or use a separate .env.production file — see below).
#
# To use a separate production env file:
#   ENV_FILE=.env.production bash scripts/push-cf-secrets.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve env file: prefer services/api/.env.production, then root .env.production,
# then services/api/.env, then root .env
ENV_FILE="${ENV_FILE:-}"
if [[ -z "$ENV_FILE" ]]; then
  for candidate in \
    "$ROOT_DIR/services/api/.env.production" \
    "$ROOT_DIR/.env.production" \
    "$ROOT_DIR/services/api/.env" \
    "$ROOT_DIR/.env"; do
    if [[ -f "$candidate" ]]; then
      ENV_FILE="$candidate"
      break
    fi
  done
fi

if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "❌  Could not find an .env file. Set ENV_FILE=/path/to/.env.production"
  exit 1
fi

echo "📄  Reading secrets from: $ENV_FILE"
echo ""

# Secrets that make sense in Cloudflare Workers production.
# NODE_ENV, PORT, API_BASE_URL etc. are either set in wrangler.jsonc vars
# or irrelevant in a Worker — skip them here.
SECRETS=(
  DATABASE_URL
  DIRECT_URL
  JWT_SECRET
  AGENT_PAIRING_SECRET
  S3_ENDPOINT
  S3_REGION
  S3_BUCKET_NAME
  S3_ACCESS_KEY_ID
  S3_SECRET_ACCESS_KEY
  RAZORPAY_KEY_ID
  RAZORPAY_KEY_SECRET
  RAZORPAY_WEBHOOK_SECRET
  EMAIL_PROVIDER
  EMAIL_API_KEY
  EMAIL_FROM
  OPERATOR_EMAIL
  PUBLIC_WEB_URL
  ALLOWED_ORIGINS
)

# Parse key=value from the env file, ignoring comments and blank lines.
# Returns the value for a given key (first match wins).
get_value() {
  local key="$1"
  # Match lines of the form KEY=... (not commented out)
  grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//"
}

pushed=0
skipped=0
missing=()

for secret in "${SECRETS[@]}"; do
  value="$(get_value "$secret")"

  if [[ -z "$value" ]]; then
    echo "⚠️   $secret — not found in $ENV_FILE (skipping)"
    missing+=("$secret")
    ((skipped++)) || true
    continue
  fi

  echo -n "🔐  Pushing $secret ... "
  # wrangler secret put reads the value from stdin
  echo "$value" | npx wrangler secret put "$secret" --no-bundle 2>&1 | tail -1
  ((pushed++)) || true
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Pushed : $pushed secret(s)"
echo "⚠️   Skipped: $skipped secret(s)"
if [[ ${#missing[@]} -gt 0 ]]; then
  echo ""
  echo "Missing keys (add them to your production .env or set manually):"
  for k in "${missing[@]}"; do
    echo "    npx wrangler secret put $k"
  done
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "After all secrets are set, redeploy to pick them up:"
echo "    npx wrangler deploy"
