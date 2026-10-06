#!/bin/bash
# Start Formic locally: the database, the schema, then the board. Returns only
# once the board answers, so whatever launched it can open the window.
#
# build.sh records the project directory beside this script (Resources/
# formic-dir), because the app lives in ~/Applications, not in the project.
set -u
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cat "$HERE/formic-dir" 2>/dev/null || true)"
PORT="${PORT:-3000}"
LOG="$HOME/Library/Logs/Formic.log"
HEALTH="http://127.0.0.1:$PORT/api/health"

# The database this board reads.
#
# A configured database is left exactly as it is — DATABASE_URL, or the
# POSTGRES_* pair Vercel's Supabase integration sets instead — because the
# desktop and the deployed app reading the same board is the whole point of a
# shared database, and what carries a level between them. With none configured,
# this is the local Homebrew database.
#
# Prisma's CLI reads the environment and not `.env` (see prisma.config.ts), so a
# database configured in `.env` is read out of it. The environment is checked
# first, and DATABASE_URL before the POSTGRES_* pair, which is the order
# src/lib/db/client.ts resolves them in.
configured_database() {
  local key value
  for key in DATABASE_URL POSTGRES_PRISMA_URL POSTGRES_URL; do
    eval "value=\${$key:-}"
    if [ -z "$value" ] && [ -f .env ]; then
      value="$(sed -nE "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*\"?([^\"]*)\"?[[:space:]]*\$/\2/p" .env | tail -1)"
    fi
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  done
  return 0
}

mkdir -p "$HOME/Library/Logs"
[ -n "$APP_DIR" ] && [ -d "$APP_DIR" ] || exit 1
cd "$APP_DIR" || exit 1

DATABASE_URL="${DATABASE_URL:-$(configured_database)}"
if [ -z "$DATABASE_URL" ]; then
  DATABASE_URL="postgresql://$(whoami)@localhost:5432/formic"
  [ -f .env ] || printf 'DATABASE_URL="%s"\n' "$DATABASE_URL" > .env
fi
export DATABASE_URL

# A database on this machine still needs Postgres running and its database to
# exist, and that is this script's job. A hosted one is somebody else's — and
# this machine need not have Postgres installed at all.
case "$DATABASE_URL" in
  *localhost* | *127.0.0.1* | *::1*)
    PGBIN=""
    for d in /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin \
             /usr/lib/postgresql/16/bin /opt/homebrew/bin /usr/local/bin; do
      [ -x "$d/pg_isready" ] && { PGBIN="$d"; break; }
    done
    [ -n "$PGBIN" ] || exit 2

    if ! "$PGBIN/pg_isready" -q 2>/dev/null; then
      brew services start postgresql@16 >/dev/null 2>&1
      for _ in $(seq 1 30); do "$PGBIN/pg_isready" -q 2>/dev/null && break; sleep 1; done
    fi
    "$PGBIN/pg_isready" -q 2>/dev/null || exit 3

    "$PGBIN/psql" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw formic || "$PGBIN/createdb" formic
    ;;
esac

# Migrations need the URL in the environment: Prisma does not read .env itself.
npm run db:push >>"$LOG" 2>&1 || true

curl -sf --max-time 2 "$HEALTH" >/dev/null 2>&1 && exit 0

: > "$LOG"
nohup npm run dev >>"$LOG" 2>&1 &
DEV=$!

for _ in $(seq 1 90); do
  curl -sf --max-time 2 "$HEALTH" >/dev/null 2>&1 && exit 0
  # The server has already given up — no node_modules, a port clash, a bad
  # compile. Waiting out the rest of the minute only delays the bad news, and
  # this script is what the window is waiting on.
  kill -0 "$DEV" 2>/dev/null || break
  sleep 1
done

echo "the board did not answer on http://127.0.0.1:$PORT; log:" >&2
tail -20 "$LOG" >&2
exit 4
