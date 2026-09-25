#!/usr/bin/env bash
# Apply committed migrations as part of `npm run build`.
#
# Two guards, both about the one database everything shares:
#  - Only production deploys migrate. Preview deploys read the same database
#    (Vercel scopes the Supabase variables to Production and Preview), so a
#    PR's build must never change the schema production is running against.
#  - `prisma migrate deploy` only applies migrations already committed to
#    prisma/migrations, in the order they were written; it never generates
#    one from the current schema, and it refuses to run if an applied
#    migration's file was edited afterwards. See docs/runbook.md.
set -euo pipefail

if [ -z "${DATABASE_URL:-}${POSTGRES_PRISMA_URL:-}${POSTGRES_URL:-}" ]; then
  echo "No database configured, skipping migrations."
  exit 0
fi

if [ -n "${VERCEL_ENV:-}" ] && [ "${VERCEL_ENV}" != "production" ]; then
  echo "VERCEL_ENV=${VERCEL_ENV}: skipping migrations, they only run on production deploys."
  exit 0
fi

# Migrations need a direct connection: Supabase's pooled URLs (pgbouncer,
# transaction mode) don't support the advisory locks `migrate deploy` needs.
if [ -n "${POSTGRES_URL_NON_POOLING:-}" ]; then
  DATABASE_URL="$POSTGRES_URL_NON_POOLING" npx prisma migrate deploy
else
  npx prisma migrate deploy
fi
