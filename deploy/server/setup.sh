#!/usr/bin/env bash
# One-time setup of an Ubuntu server (a Google Cloud e2-micro or an AWS
# Lightsail instance, see docs/google-cloud.md and docs/aws.md) to run Formic.
# Upload this file to the server, then:
#
#   sudo bash setup.sh
#
# or with your own domain (its A record already pointing at the server):
#
#   sudo DOMAIN=formic.example.com bash setup.sh
#
# Without DOMAIN it uses <ip>.sslip.io, which resolves to the server's IP with
# no DNS to set up, so Caddy can still get a real HTTPS certificate.
#
# Safe to run again: every step checks before it changes anything.
set -euo pipefail

NODE_MAJOR=22
APP=/opt/formic

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash setup.sh" >&2
  exit 1
fi

ip="$(curl -fsS --max-time 10 https://api.ipify.org)"
DOMAIN="${DOMAIN:-$(echo "$ip" | tr . -).sslip.io}"
echo "==> Public IP $ip, serving on https://$DOMAIN"

# 1 GB of memory is enough to run the app, not to start it alongside a
# migration and Caddy with room to spare. Swap covers the peaks.
echo "==> Swap"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl gnupg nano debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -yq nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

# Postgres lives on this server: the app reaches it over localhost, so there
# is no egress meter or monthly cap to run out of. PGDG's packages rather than
# Ubuntu's, so pg_dump is new enough to copy a database off Neon or Supabase.
PG_MAJOR=18
echo "==> Postgres $PG_MAJOR"
if ! command -v "/usr/lib/postgresql/$PG_MAJOR/bin/postgres" >/dev/null; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor --yes -o /usr/share/keyrings/postgresql.gpg
  echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q
  apt-get install -yq "postgresql-$PG_MAJOR"
fi

# Sized for a 1 GB server shared with the app. It listens on localhost only,
# which is Postgres's default.
cat > "/etc/postgresql/$PG_MAJOR/main/conf.d/formic.conf" <<'EOF'
max_connections = 20
shared_buffers = 64MB
effective_cache_size = 256MB
work_mem = 4MB
maintenance_work_mem = 32MB
EOF
systemctl restart postgresql

# Nightly dump, a week kept. It sits on the same disk, so it covers mistakes
# in the data; Lightsail's automatic snapshots cover losing the disk.
mkdir -p /var/backups/formic
chown postgres:postgres /var/backups/formic
chmod 700 /var/backups/formic
cat > /etc/cron.d/formic-backup <<'EOF'
30 3 * * * postgres pg_dump --format=custom --file /var/backups/formic/formic-$(date -u +\%Y\%m\%d).dump formic && find /var/backups/formic -name '*.dump' -mtime +7 -delete
EOF

echo "==> formic user"
if ! id formic >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/formic --shell /bin/bash formic
fi
mkdir -p "$APP/releases" "$APP/shared" /home/formic/.ssh
chown -R formic:formic "$APP" /home/formic/.ssh
chmod 700 /home/formic/.ssh

# The one thing CI may do as root: restart the app after a deploy.
cat > /etc/sudoers.d/formic <<'EOF'
formic ALL=(root) NOPASSWD: /usr/bin/systemctl restart formic, /usr/bin/systemctl status formic --no-pager
EOF
chmod 440 /etc/sudoers.d/formic

if [ ! -f "$APP/shared/.env" ]; then
  cat > "$APP/shared/.env" <<EOF
# Formic's production environment. Same variables as on Vercel; see
# .env.example in the repo. FORMIC_URL must be set here: Vercel filled it in
# on its own, this server does not.
NODE_ENV=production
FORMIC_URL="https://$DOMAIN"
SANDBOX_PROVIDER="e2b"
DATABASE_URL=""
FORMIC_SECRET=""
GITHUB_APP_CLIENT_ID=""
GITHUB_APP_CLIENT_SECRET=""
GITHUB_APP_SLUG=""
GITHUB_WEBHOOK_SECRET=""
FORMIC_ALLOWED_USERS=""
E2B_API_KEY=""
EOF
  chown formic:formic "$APP/shared/.env"
  chmod 600 "$APP/shared/.env"
fi

echo "==> Database"
LOCAL_DB="$APP/shared/local-database-url"
if [ ! -f "$LOCAL_DB" ]; then
  # Hex, so the password needs no escaping inside a URL.
  echo "postgresql://formic:$(openssl rand -hex 24)@127.0.0.1:5432/formic" > "$LOCAL_DB"
  chown formic:formic "$LOCAL_DB"
  chmod 600 "$LOCAL_DB"
fi
# The role always gets the saved password, so a rebuilt cluster matches it.
pw="$(sed -E 's#^postgresql://formic:([^@]*)@.*#\1#' "$LOCAL_DB")"
if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = 'formic'" | grep -q 1; then
  sudo -u postgres psql -qc "alter role formic with login password '$pw'"
else
  sudo -u postgres psql -qc "create role formic with login password '$pw'"
fi
if ! sudo -u postgres psql -tAc "select 1 from pg_database where datname = 'formic'" | grep -q 1; then
  sudo -u postgres createdb --owner formic formic
fi
# A fresh .env gets the local database. One already pointing elsewhere is
# left alone: docs/aws.md says how to move that data across first.
if grep -q '^DATABASE_URL=""$' "$APP/shared/.env"; then
  sed -i "s#^DATABASE_URL=\"\"\$#DATABASE_URL=\"$(cat "$LOCAL_DB")\"#" "$APP/shared/.env"
fi

echo "==> Deploy key for GitHub Actions"
if [ ! -f /home/formic/.ssh/deploy ]; then
  sudo -u formic ssh-keygen -q -t ed25519 -N "" -C "formic-deploy" -f /home/formic/.ssh/deploy
  cat /home/formic/.ssh/deploy.pub >> /home/formic/.ssh/authorized_keys
  chown formic:formic /home/formic/.ssh/authorized_keys
  chmod 600 /home/formic/.ssh/authorized_keys
fi

echo "==> Service"
cat > /etc/systemd/system/formic.service <<EOF
[Unit]
Description=Formic
After=network-online.target
Wants=network-online.target

[Service]
User=formic
WorkingDirectory=$APP/current
EnvironmentFile=$APP/shared/.env
EnvironmentFile=-$APP/current/.release.env
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
Restart=always
RestartSec=3
# Agent runs in flight get a moment to settle; recovery picks up the rest.
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable formic >/dev/null

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy || systemctl restart caddy

cat <<EOF

==> Done. Next:

1. Fill in $APP/shared/.env (sudo -u formic nano $APP/shared/.env)
   with the values from Vercel. DATABASE_URL is the local database
   unless it already pointed somewhere else; to move existing data here,
   see "Database" in docs/aws.md.

2. In GitHub (Settings > Secrets and variables > Actions):
   variable  DEPLOY_HOST      $ip
   variable  PRODUCTION_URL   https://$DOMAIN
   secret    DEPLOY_SSH_KEY   the private key below

----- DEPLOY_SSH_KEY -----
$(cat /home/formic/.ssh/deploy)
--------------------------

3. Point the GitHub App's callback, setup and webhook URLs at https://$DOMAIN.

4. Re-run the CI workflow on main (or merge anything) to deploy.
EOF
