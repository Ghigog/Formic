# Hosting on Google Cloud

Formic runs on Google Cloud's free **e2-micro** server: Node serves the app,
Caddy puts HTTPS in front of it, and CI builds every green commit on `main` and
ships it over SSH. The database stays where it is (Supabase or Neon); only the
app moves.

The e2-micro has 1 GB of memory — enough to run the app, not to build it — so
GitHub Actions builds and the server only unpacks, migrates and restarts. On a
long-running server nothing is frozen after a response, so agent runs are no
longer capped by a function's `maxDuration`. That is the point of moving.

This is the alternative to `docs/vercel.md`, and it can coexist with it: with
`DEPLOY_HOST` unset, CI deploys to Vercel exactly as before.

> **Prerequisite.** This path is added by the "Deploy to a Google Cloud
> e2-micro when DEPLOY_HOST is set" change (PR #456): the server scripts
> `deploy/server/setup.sh` and `deploy/server/deploy.sh`, the CI `deploy`
> branch, and `FORMIC_COMMIT` in `/api/health`. Merge that first (or work from
> its branch); on `main` before it, those files and this branch of the deploy
> job do not exist yet.

## 1. Account

1. Sign up at https://cloud.google.com/free. It asks for a card; the free tier
   does not charge it.
2. Click **Activate full account** (top of the console) straight away. The $300
   trial stops every server when it ends unless the account is upgraded; the
   e2-micro stays free either way.
3. **Billing > Budgets & alerts > Create budget:** $1, alerts on. Anything
   outside the free tier then shows up at once.

## 2. Create the server

**Compute Engine > VM instances > Create instance** (enable the Compute Engine
API when asked):

- **Name:** `formic`.
- **Region:** `us-central1`, `us-west1` or `us-east1`. Only these are free.
- **Machine:** series E2, type `e2-micro`.
- **Boot disk:** Change > Ubuntu 24.04 LTS (x86/64), disk type **Standard
  persistent disk**, 30 GB. The default "Balanced" disk is not free.
- **Firewall:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**.

Leave the rest as it is and create it. Note its **External IP** — it stays the
same while the server keeps running.

## 3. Set it up

On the instance's row, click **SSH**. In the window that opens, use **Upload
file** (top right) to upload `deploy/server/setup.sh` from this repository, then
run:

```bash
sudo bash setup.sh
```

It is safe to run again — every step checks before it changes anything. It:

- adds a 2 GB swap file (the 1 GB of RAM needs the headroom);
- installs Node 22, Caddy, and `nano` (the minimal image ships no editor);
- creates a `formic` user and a systemd service (`/opt/formic/current`, port
  3000, bound to `127.0.0.1`);
- writes a starter `/opt/formic/shared/.env`;
- generates an ed25519 deploy key at `/home/formic/.ssh/deploy`;
- points Caddy at the app and prints exactly what to do next, including the
  private key.

It serves on `https://<ip-with-dashes>.sslip.io` — a hostname that resolves to
the IP, so HTTPS works with no DNS. For your own domain, point its A record at
the server and run `sudo DOMAIN=formic.example.com bash setup.sh` instead.

## 4. Fill in the environment

The server does **not** inherit Vercel's variables, and unlike Vercel it does
not fill in `FORMIC_URL` on its own. In the same SSH window:

```bash
sudo -u formic nano /opt/formic/shared/.env
```

`setup.sh` writes a template with `FORMIC_URL` already set to the new address
and `SANDBOX_PROVIDER=e2b`. Copy the rest from the Vercel project:

| Variable | What to do |
| :-- | :-- |
| `DATABASE_URL` | Same value as production. `docs/database.md` covers the pooled/direct split. |
| `FORMIC_SECRET` | **Copy the same value you used before**, or every saved agent key and session becomes unreadable. |
| `GITHUB_APP_CLIENT_ID` / `_SECRET` / `_SLUG` | Same as Vercel. |
| `GITHUB_WEBHOOK_SECRET` | Same as Vercel. |
| `FORMIC_ALLOWED_USERS` | Optional; same as Vercel. |
| `E2B_API_KEY` | Same as Vercel (a fallback for people without their own). |
| `FORMIC_URL` | Already set. Leave it as the new `https://` address. |
| `SANDBOX_PROVIDER` | Leave `e2b`. |

Save with Ctrl+O, Enter, Ctrl+X. The service reads this file on every restart,
so changes take effect with `sudo systemctl restart formic`.

## 5. Connect GitHub

**This repository > Settings > Secrets and variables > Actions:**

| Kind | Name | Value |
| :-- | :-- | :-- |
| variable | `DEPLOY_HOST` | The External IP |
| variable | `PRODUCTION_URL` | `https://<domain>` (for the smoke test) |
| secret | `DEPLOY_SSH_KEY` | The private key `setup.sh` printed, BEGIN/END lines included |

With `DEPLOY_HOST` set, CI's `deploy` job goes to the server instead of Vercel.
With it empty, nothing about the job changes — that is what makes merging this
safe before the server exists.

**The GitHub App** (github.com > Settings > Developer settings > GitHub Apps):
change the **callback URL**, **setup URL** and **webhook URL** to the new
`https://` address. Until you do, sign-in and webhooks still point at Vercel.

## 6. Deploy

Merge anything to `main`, or re-run the CI workflow on its latest commit. The
`deploy` job builds on the runner, uploads the release to
`/opt/formic/releases/<sha>.tgz`, copies `deploy/server/deploy.sh` up, and runs
it as the `formic` user. `deploy.sh` unpacks the release, runs the migrations
from `/opt/formic/shared/.env`, writes `.release.env` with `FORMIC_COMMIT`, moves
`/opt/formic/current` to the new release, restarts the service, and waits for
`/api/health` to report the new commit. It keeps the newest three releases.

## Edge cases worth knowing

- **Merging early is harmless.** Every server step is gated on
  `env.DEPLOY_HOST != ''`. Until you set that variable, the `deploy` job runs
  the Vercel path unchanged. So this can be merged before the server exists —
  the only thing that changes is when you set `DEPLOY_HOST`.
- **`/api/health` needs `FORMIC_COMMIT`.** Off Vercel there is no
  `VERCEL_GIT_COMMIT_SHA`, so `deploy.sh` writes `FORMIC_COMMIT=<sha>` into
  `.release.env` (loaded by the systemd unit) and `/api/health` and error
  tracking read it. That is how the smoke test and `deploy.sh` confirm the
  *right* release is live — a stale server answers every request perfectly
  well, so the commit is the only honest check.
- **The release is built on the runner, not the server.** The e2-micro cannot
  `npm run build` in 1 GB. If you ever build on the box by hand, expect it to
  swap hard or be OOM-killed.
- **A failure leaves the running app alone.** `current` only moves once the
  new release is unpacked and migrated, so a bad release fails the deploy
  without taking the site down.
- **The `.env` is the whole configuration.** There is no Vercel-style
  dashboard here: `FORMIC_URL` and every credential live in
  `/opt/formic/shared/.env`, and the systemd unit loads it as the environment.
  A missing `FORMIC_URL` degrades CLI-agent reporting; a missing
  `DATABASE_URL` drops the app to the in-memory store.
- **`FORMIC_SECRET` must match what you used before** if you want previously
  saved keys to keep decrypting. A new value signs everyone out and orphans
  every stored key.
- **The database does not move.** Migrations run on the server from the shared
  `.env`; the pooled/direct, `sslmode` and baseline details are in
  `docs/database.md`. `POSTGRES_URL_NON_POOLING` matters here for the same
  reason it does on Vercel.
- **Caddy needs ports 80 and 443 open** (the firewall tick in step 2) and a
  domain that resolves to the server (sslip.io does this for free). If HTTPS
  never issues, that is almost always a closed port or a wrong A record.

## Day to day

```bash
sudo journalctl -u formic -f          # app logs
sudo systemctl restart formic         # restart
ls -t /opt/formic/releases            # the last three releases
```

**Roll back:** point `current` at an older release and restart:

```bash
sudo -u formic ln -sfn /opt/formic/releases/<older-sha> /opt/formic/current
sudo systemctl restart formic
```

Keep migrations additive (`docs/database.md`) and an application rollback needs
no schema rollback.

**Back to Vercel:** delete the `DEPLOY_HOST` variable. The next deploy goes to
Vercel again; point the GitHub App URLs back at the Vercel address, and the
smoke test's `PRODUCTION_URL` with them.
