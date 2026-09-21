#!/usr/bin/env bash
# Start the built app on a clean port, waiting until it actually answers.
set -euo pipefail
PORT="${PORT:-3111}"
LOG="${LOG:-/tmp/formic-server.log}"

for p in $(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  kill -9 "$p" 2>/dev/null || true
done
sleep 1

: > "$LOG"
setsid nohup npx next start -p "$PORT" > "$LOG" 2>&1 < /dev/null &

for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null --max-time 2 "http://localhost:$PORT/api/board" 2>/dev/null; then
    echo "up on $PORT"
    exit 0
  fi
  sleep 1
done

echo "failed to start; log:" >&2
tail -20 "$LOG" >&2
exit 1
