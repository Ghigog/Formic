#!/usr/bin/env bash
# Switches the server to one release. CI builds the commit, uploads it as
# releases/<sha>.tgz, copies this script up, then runs it as the formic user:
#
#   bash /opt/formic/deploy.sh <sha>
#
# The server only unpacks and migrates: with 1 GB of memory it can run the
# app but not build it. `current` only moves once the release is in place and
# migrated, so a failure leaves the running app untouched. Rolling back is
# pointing `current` at an older release and restarting.
set -euo pipefail

SHA="$1"
APP=/opt/formic
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

ln -sfn "$REL" "$APP/current.new"
mv -T "$APP/current.new" "$APP/current"
sudo /usr/bin/systemctl restart formic

# /api/health reports the commit to anyone, so it confirms the restarted
# server is this release and not the one before it.
for _ in $(seq 1 60); do
  served="$(curl -fsS --max-time 2 http://127.0.0.1:3000/api/health 2>/dev/null | grep -o '"commit":"[^"]*"' | cut -d'"' -f4 || true)"
  if [ "$served" = "$SHA" ]; then
    echo "==> Live: $SHA"
    # Keep the newest few releases for rollback; drop the rest.
    ls -1dt "$APP"/releases/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
      [ "$(readlink -f "$old")" = "$(readlink -f "$APP/current")" ] || rm -rf "$old"
    done
    exit 0
  fi
  sleep 2
done

echo "Server did not come up on $SHA:" >&2
sudo /usr/bin/systemctl status formic --no-pager >&2 || true
exit 1
