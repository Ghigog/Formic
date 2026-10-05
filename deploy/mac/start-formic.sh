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

# Postgres, wherever Homebrew put it.
PGBIN=""
for d in /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin \
         /usr/lib/postgresql/16/bin /opt/homebrew/bin /usr/local/bin; do
  [ -x "$d/pg_isready" ] && { PGBIN="$d"; break; }
done

mkdir -p "$HOME/Library/Logs"
[ -n "$PGBIN" ] || exit 2
[ -n "$APP_DIR" ] && [ -d "$APP_DIR" ] || exit 1
cd "$APP_DIR" || exit 1

if ! "$PGBIN/pg_isready" -q 2>/dev/null; then
  brew services start postgresql@16 >/dev/null 2>&1
  for _ in $(seq 1 30); do "$PGBIN/pg_isready" -q 2>/dev/null && break; sleep 1; done
fi
"$PGBIN/pg_isready" -q 2>/dev/null || exit 3

export DATABASE_URL="${DATABASE_URL:-postgresql://$(whoami)@localhost:5432/formic}"
[ -f .env ] || printf 'DATABASE_URL="%s"\n' "$DATABASE_URL" > .env
"$PGBIN/psql" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw formic || "$PGBIN/createdb" formic

# Migrations need the URL in the environment: Prisma does not read .env itself.
npm run db:push >>"$LOG" 2>&1 || true

curl -sf --max-time 2 "$HEALTH" >/dev/null 2>&1 && exit 0

: > "$LOG"
nohup npm run dev >>"$LOG" 2>&1 &

for _ in $(seq 1 90); do
  curl -sf --max-time 2 "$HEALTH" >/dev/null 2>&1 && exit 0
  sleep 1
done
exit 4
