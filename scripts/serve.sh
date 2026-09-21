#!/usr/bin/env bash
# Start the built app on a clean port and confirm the running server is the
# build that is currently on disk. Without the build-id check it is easy to
# think a stale server is the new one, because it answers every request.
set -euo pipefail

PORT="${PORT:-3111}"
LOG="${LOG:-/tmp/formic-server.log}"
BUILD_ID="$(cat .next/BUILD_ID)"

# `ss -ltnp` hides pids without the right privileges, and a silent empty
# result reads exactly like "nothing is listening" — which is how a stale
# server survives a restart and answers as if it were the new build.
port_pids() {
  fuser "$PORT/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
}

stop_port() {
  for sig in TERM TERM KILL; do
    pids="$(port_pids)"
    [ -z "$pids" ] && return 0
    for p in $pids; do kill "-$sig" "$p" 2>/dev/null || true; done
    sleep 2
  done
  if [ -n "$(port_pids)" ]; then
    echo "port $PORT is still held by: $(port_pids)" >&2
    exit 1
  fi
}

stop_port

: > "$LOG"
setsid nohup npx next start -p "$PORT" > "$LOG" 2>&1 < /dev/null &

for _ in $(seq 1 45); do
  served="$(curl -fsS --max-time 2 "http://localhost:$PORT/api/health" 2>/dev/null | grep -o '"buildId":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ -n "$served" ]; then
    if [ "$served" = "$BUILD_ID" ]; then
      echo "up on $PORT (build $BUILD_ID)"
      exit 0
    fi
    echo "port $PORT is serving a different build ($served, expected $BUILD_ID)" >&2
    exit 1
  fi
  sleep 1
done

echo "failed to start; log:" >&2
tail -20 "$LOG" >&2
exit 1
