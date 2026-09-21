#!/usr/bin/env bash
# Start a throwaway local Postgres for development and verification.
# Not part of the app: production points DATABASE_URL at a real database.
set -euo pipefail

PGDATA="${PGDATA:-/tmp/formic-pgdata}"
PGPORT="${PGPORT:-5433}"
PGSOCK="${PGSOCK:-/tmp/formic-pgrun}"
export PATH="/usr/lib/postgresql/16/bin:$PATH"

as_postgres() {
  if [ "$(id -u)" = "0" ]; then su postgres -c "PATH=/usr/lib/postgresql/16/bin:\$PATH $1"; else bash -lc "$1"; fi
}

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  rm -rf "$PGDATA"; mkdir -p "$PGDATA" "$PGSOCK"
  [ "$(id -u)" = "0" ] && chown -R postgres "$PGDATA" "$PGSOCK"
  as_postgres "initdb -D $PGDATA -A trust -U formic" >/dev/null
fi

mkdir -p "$PGSOCK"; [ "$(id -u)" = "0" ] && chown -R postgres "$PGSOCK" "$PGDATA"

if ! as_postgres "pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
  as_postgres "pg_ctl -D $PGDATA -o '-p $PGPORT -k $PGSOCK -c listen_addresses=127.0.0.1' -l $PGDATA/log start" >/dev/null
fi

for _ in $(seq 1 30); do
  if psql -h 127.0.0.1 -p "$PGPORT" -U formic -d postgres -c 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

psql -h 127.0.0.1 -p "$PGPORT" -U formic -d postgres -tc \
  "select 1 from pg_database where datname='formic'" | grep -q 1 \
  || psql -h 127.0.0.1 -p "$PGPORT" -U formic -d postgres -c "create database formic" >/dev/null

echo "postgresql://formic@127.0.0.1:$PGPORT/formic"
