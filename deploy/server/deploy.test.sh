#!/usr/bin/env bash
# Runs deploy.sh against a temp directory with a stubbed systemctl and a
# health file in place of the server:  bash deploy/server/deploy.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

setup() {
  rm -rf "$T/app"; mkdir -p "$T/app/shared" "$T/app/releases/old1" "$T/app/releases/old2" "$T/app/releases/old3" "$T/pkg/scripts"
  touch "$T/app/shared/.env"; : > "$T/restarts"
  ln -s "$T/app/releases/old3" "$T/app/current"
  touch -d '3 days ago' "$T/app/releases/old1"; touch -d '2 days ago' "$T/app/releases/old2"; touch -d '1 day ago' "$T/app/releases/old3"
  echo 'true' > "$T/pkg/scripts/db-push.sh"
  tar -czf "$T/app/releases/new.tgz" -C "$T/pkg" .
  printf '#!/bin/sh\necho "$@" >> "%s/restarts"\n' "$T" > "$T/systemctl"; chmod +x "$T/systemctl"
}
run() {
  APP="$T/app" SYSTEMCTL="$T/systemctl" HEALTH_URL="file://$T/health.json" HEALTH_TRIES=2 HEALTH_SLEEP=0 \
    bash "$HERE/deploy.sh" new >"$T/out" 2>&1
}

setup; echo '{"ok":true,"commit":"old3"}' > "$T/health.json"; run; rc=$?
check "unhealthy release exits non-zero" '[ $rc -ne 0 ]'
check "current is back on the previous release" '[ "$(readlink -f "$T/app/current")" = "$(readlink -f "$T/app/releases/old3")" ]'
check "service restarted twice" '[ "$(grep -c restart "$T/restarts")" -eq 2 ]'

setup; echo '{"ok":true,"commit":"new"}' > "$T/health.json"; run; rc=$?
check "healthy release exits zero" '[ $rc -eq 0 ]'
check "current stays on the new release" '[ "$(readlink -f "$T/app/current")" = "$(readlink -f "$T/app/releases/new")" ]'
check "old releases are pruned" '[ ! -e "$T/app/releases/old1" ] && [ -e "$T/app/releases/old2" ]'
exit $fail
