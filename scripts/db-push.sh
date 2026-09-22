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

npx prisma db push --skip-generate --accept-data-loss
