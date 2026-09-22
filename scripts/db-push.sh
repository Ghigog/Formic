#!/usr/bin/env bash
# Apply prisma/schema.prisma as part of `npm run build`.
#
# Two guards, both about the one database everything shares:
#  - Only production deploys push. Preview deploys read the same database
#    (Vercel scopes the Supabase variables to Production and Preview), so a
#    PR's build must never change the schema production is running against.
#  - No --accept-data-loss. Additive changes apply; a change that would drop
#    data fails the build instead, so a human runs it on purpose.
set -euo pipefail

if [ -z "${DATABASE_URL:-}${POSTGRES_PRISMA_URL:-}${POSTGRES_URL:-}" ]; then
  echo "No database configured, skipping schema push."
  exit 0
fi

if [ -n "${VERCEL_ENV:-}" ] && [ "${VERCEL_ENV}" != "production" ]; then
  echo "VERCEL_ENV=${VERCEL_ENV}: skipping schema push, it only runs on production deploys."
  exit 0
fi

# Schema changes need a direct connection: Supabase's pooled URLs (pgbouncer,
# transaction mode) don't support the advisory locks `db push` needs.
if [ -n "${POSTGRES_URL_NON_POOLING:-}" ]; then
  npx prisma db push --url "$POSTGRES_URL_NON_POOLING"
else
  npx prisma db push
fi
