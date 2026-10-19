#!/usr/bin/env bash
# Switches the server to one release. CI builds the commit, uploads it as
# releases/<sha>.tgz, copies this script up, then runs it as the formic user:
#
#   bash /opt/formic/deploy.sh <sha>
#
# The server only unpacks and migrates: with 1 GB of memory it can run the
# app but not build it. `current` only moves once the release is in place and
# migrated, so a failure there leaves the running app untouched. If the
# restarted server never reports this commit on /api/health, `current` is
# pointed back at the previous release, the service is restarted on it and the
# script exits non-zero, so the deploy shows as failed and users keep a working
# release. Rolling back by hand is the same: point `current` at an older
# release and restart.
set -euo pipefail

SHA="$1"
APP="${APP:-/opt/formic}"
# Overridable so deploy/server/deploy.test.sh can run this against a temp directory.
SYSTEMCTL="${SYSTEMCTL:-sudo /usr/bin/systemctl}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TRIES="${HEALTH_TRIES:-60}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"
REL="$APP/releases/$SHA"
KEEP=3

rm -rf "$REL"
mkdir -p "$REL"
tar -xzf "$REL.tgz" -C "$REL"
rm -f "$REL.tgz"
cd "$REL"

# Migrations need the database, which only the server knows.
set -a
# shellcheck disable=SC1091
. "$APP/shared/.env"
set +a
echo "==> Migrations"
bash scripts/db-push.sh
echo "FORMIC_COMMIT=$SHA" > .release.env

switch_to() {
  ln -sfn "$1" "$APP/current.new"
  mv -T "$APP/current.new" "$APP/current"
  $SYSTEMCTL restart formic
}

# Empty on the first deploy, when there is nothing to roll back to.
previous="$(readlink -f "$APP/current" 2>/dev/null || true)"
switch_to "$REL"

# /api/health reports the commit to anyone, so it confirms the restarted
# server is this release and not the one before it.
for _ in $(seq 1 "$HEALTH_TRIES"); do
  served="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | grep -o '"commit":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ "$served" = "$SHA" ]; then
    echo "==> Live: $SHA"
    # Keep the newest few releases for rollback; drop the rest.
    ls -1dt "$APP"/releases/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
      [ "$(readlink -f "$old")" = "$(readlink -f "$APP/current")" ] || rm -rf "$old"
    done
    exit 0
  fi
  sleep "$HEALTH_SLEEP"
done

echo "Server did not come up on $SHA:" >&2
$SYSTEMCTL status formic --no-pager >&2 || true
if [ -n "$previous" ] && [ -d "$previous" ] && [ "$previous" != "$REL" ]; then
  echo "==> Rolling back to $previous" >&2
  switch_to "$previous"
else
  echo "No previous release to roll back to." >&2
fi
exit 1
