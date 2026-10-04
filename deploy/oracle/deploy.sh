#!/usr/bin/env bash
# Builds and switches to one release on the Oracle VM. CI runs it as the
# formic user, after unpacking the commit into releases/<sha>:
#
#   bash /opt/formic/releases/<sha>/deploy/oracle/deploy.sh <sha>
#
# Each release is built in its own directory and `current` only moves once
# the build succeeds, so a failed build leaves the running app untouched.
# Rolling back is pointing `current` at an older release and restarting.
set -euo pipefail

SHA="$1"
APP=/opt/formic
REL="$APP/releases/$SHA"
KEEP=3

cd "$REL"

# The build runs migrations (scripts/db-push.sh), so it needs the database.
set -a
# shellcheck disable=SC1091
. "$APP/shared/.env"
set +a

echo "==> npm ci"
# The .env sets NODE_ENV=production, which would skip the build's tooling.
npm ci --include=dev --no-audit --no-fund
echo "==> npm run build"
npm run build
echo "FORMIC_COMMIT=$SHA" > .release.env

ln -sfn "$REL" "$APP/current.new"
mv -T "$APP/current.new" "$APP/current"
sudo /usr/bin/systemctl restart formic

BUILD_ID="$(cat .next/BUILD_ID)"
for _ in $(seq 1 60); do
  served="$(curl -fsS --max-time 2 http://127.0.0.1:3000/api/health 2>/dev/null | grep -o '"buildId":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ "$served" = "$BUILD_ID" ]; then
    echo "==> Live: $SHA (build $BUILD_ID)"
    # Keep the newest few releases for rollback; drop the rest.
    ls -1dt "$APP"/releases/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
      [ "$(readlink -f "$old")" = "$(readlink -f "$APP/current")" ] || rm -rf "$old"
    done
    exit 0
  fi
  sleep 2
done

echo "Server did not come up on build $BUILD_ID:" >&2
sudo /usr/bin/systemctl status formic --no-pager >&2 || true
exit 1
