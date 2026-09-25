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
  export DATABASE_URL="$POSTGRES_URL_NON_POOLING"
fi

# A database first built with `db push` has the schema but no migration
# history, and `migrate deploy` refuses it (P3005). Its schema is exactly
# the baseline migration, so mark that one applied, once, and go on. From
# then on the history exists and this never runs again.
BASELINE=20260925000000_init
set +e
out=$(npx prisma migrate deploy 2>&1)
status=$?
set -e
echo "$out"
if [ $status -ne 0 ]; then
  if ! grep -q "P3005" <<<"$out"; then
    exit $status
  fi
  echo "Database predates migrations: marking $BASELINE as applied."
  npx prisma migrate resolve --applied "$BASELINE"
  npx prisma migrate deploy
fi
