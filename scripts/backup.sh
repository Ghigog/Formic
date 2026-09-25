#!/usr/bin/env bash
# Take a portable logical backup of the Formic database.
#
# The hosting provider's point-in-time recovery (Supabase, Neon and RDS all
# offer continuous, WAL-based PITR) is what a bad deploy actually gets
# restored from in production; turn that on there. This script is for taking
# a snapshot on demand — before a risky migration, or to rehearse the
# runbook's restore drill against staging. See docs/runbook.md.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL_NON_POOLING:-${POSTGRES_URL:-}}}"
if [ -z "$DATABASE_URL" ]; then
  echo "Usage: DATABASE_URL=postgresql://... $0 [output-file]" >&2
  exit 1
fi

OUT_DIR="${FORMIC_BACKUP_DIR:-/tmp/formic-backups}"
mkdir -p "$OUT_DIR"
OUT="${1:-$OUT_DIR/formic-$(date -u +%Y%m%dT%H%M%SZ).dump}"

# Custom format: compressed, and restorable with pg_restore --clean without
# hand-writing DROP statements first.
pg_dump --format=custom --no-owner --no-privileges --file "$OUT" "$DATABASE_URL"
echo "Backup written to $OUT"
