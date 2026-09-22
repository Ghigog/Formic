#!/usr/bin/env bash
# Apply prisma/schema.prisma to whichever database is configured, as part of
# `npm run build`. `db push` is a schema diff, not a data operation, so this
# is safe to run on every deploy — and a deploy with no database configured
# is a no-op here, not a failure, matching the rest of the app's "each
# credential unlocks a layer" behaviour.
set -euo pipefail

if [ -z "${DATABASE_URL:-}${POSTGRES_PRISMA_URL:-}${POSTGRES_URL:-}" ]; then
  echo "No DATABASE_URL configured, skipping schema push."
  exit 0
fi

# Schema changes need a direct connection: Supabase's pooled URLs (pgbouncer,
# transaction mode) don't support the advisory locks and prepared statements
# `db push` needs. POSTGRES_URL_NON_POOLING is the direct one Vercel's
# Supabase integration sets alongside the pooled ones — pass it via --url so
# this command alone uses it, leaving the app's own runtime connection
# (pooled) untouched.
if [ -n "${POSTGRES_URL_NON_POOLING:-}" ]; then
  npx prisma db push --accept-data-loss --url "$POSTGRES_URL_NON_POOLING"
else
  npx prisma db push --accept-data-loss
fi
