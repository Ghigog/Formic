#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into a database.
#
# This drops and recreates every table the dump contains before loading it.
# Point it at staging, never at production — the runbook's restore drill
# (docs/runbook.md) always targets the staging database.
set -euo pipefail

DUMP="${1:-}"
DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}}"

if [ -z "$DUMP" ] || [ -z "$DATABASE_URL" ]; then
  echo "Usage: DATABASE_URL=postgresql://... $0 <dump-file>" >&2
  exit 1
fi

# Never print the URL as-is: it carries the password.
redacted="$(echo "$DATABASE_URL" | sed -E 's#//[^@/]*@#//***@#')"
echo "Restoring $DUMP into $redacted"

pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$DUMP"
echo "Restore complete."
