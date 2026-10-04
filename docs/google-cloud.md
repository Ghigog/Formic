# Hosting on Google Cloud

Formic runs on Google Cloud's free e2-micro server: Node serves the app,
Caddy puts HTTPS in front of it, and CI builds every green commit on `main`
and ships it over SSH. The database stays where it is (Supabase or Neon);
only the app moves.

The e2-micro has 1 GB of memory: enough to run the app, not to build it, so
GitHub Actions builds and the server only unpacks, migrates and restarts. On
a long-running server nothing is frozen after a response, so agent runs are
no longer capped by a function's `maxDuration`.

## 1. Account

1. Sign up at https://cloud.google.com/free. It asks for a card; the free
   tier does not charge it.
2. Click **Activate full account** (top of the console) straight away. The
   $300 trial stops every server when it ends unless the account is
   upgraded; the e2-micro stays free either way.
3. **Billing > Budgets & alerts > Create budget:** $1, alerts on. Anything
   outside the free tier then shows up at once.

## 2. Create the server

**Compute Engine > VM instances > Create instance** (enable the Compute
Engine API when asked):

- **Name:** `formic`.
- **Region:** `us-central1`, `us-west1` or `us-east1`. Only these are free.
- **Machine:** series E2, type `e2-micro`.
- **Boot disk:** Change > Ubuntu 24.04 LTS (x86/64), disk type **Standard
  persistent disk**, 30 GB. The default "Balanced" disk is not free.
- **Firewall:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**.

Leave the rest as it is and create it. Note its **External IP**. It stays the
same while the server keeps running.

## 3. Set it up

On the instance's row, click **SSH**. In the window that opens, use **Upload
file** (top right) to upload `deploy/server/setup.sh` from this repository,
then run:

```bash
sudo bash setup.sh
```

It adds swap, installs Node 22 and Caddy, creates a `formic` user and
service, and serves on `https://<ip-with-dashes>.sslip.io` (a hostname that
resolves to the IP, so HTTPS works with no DNS). For your own domain, point
its A record at the server and run `sudo DOMAIN=formic.example.com bash
setup.sh` instead. It ends by printing what to do next, including a deploy
key.

## 4. Fill in the environment

In the same SSH window:

```bash
sudo -u formic nano /opt/formic/shared/.env
```

Copy the values from the Vercel project's environment variables.
`FORMIC_URL` is already set to the new address; Vercel used to fill that in
on its own. Save with Ctrl+O, Enter, Ctrl+X.

## 5. Connect GitHub

- **This repository > Settings > Secrets and variables > Actions:**
  variable `DEPLOY_HOST` (the External IP), variable `PRODUCTION_URL` (the
  new `https://` address, for the smoke test), secret `DEPLOY_SSH_KEY` (the
  key the setup script printed, including the BEGIN and END lines). With
  `DEPLOY_HOST` set, CI's `deploy` job goes to the server instead of Vercel.
- **The GitHub App** (github.com > Settings > Developer settings > GitHub
  Apps): change the callback URL, setup URL and webhook URL to the new
  address.

## 6. Deploy

Merge anything to `main`, or re-run the CI workflow on its latest commit. The
`deploy` job builds, uploads the release to `/opt/formic/releases/<sha>`,
runs the migrations there, switches `/opt/formic/current` to it and
restarts. `/api/health` then reports the new commit.

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

**Back to Vercel:** delete the `DEPLOY_HOST` variable; the next deploy goes
to Vercel again, and the GitHub App URLs go back to the Vercel address.
