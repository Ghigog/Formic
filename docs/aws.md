# Hosting on AWS Lightsail

Formic runs on an AWS **Lightsail** instance the same way it runs on Google
Cloud's e2-micro: Node serves the app, Caddy puts HTTPS in front of it, and a
manual CI run builds the app and ships it over SSH. Postgres runs on the same
server, so there is no database bill and no transfer cap to run out of (see
[Database](#database)).

Everything on the server side is shared with `docs/google-cloud.md`: the same
`deploy/server/setup.sh`, the same `deploy.sh`, the same `DEPLOY_HOST` switch in
CI. Only the account and the instance are different, so this page covers those
in full and points to the Google Cloud guide for the rest.

On a long-running server nothing is frozen after a response, so agent runs are
not capped by a function's `maxDuration`. That is the reason to move off Vercel.

## Why Lightsail, not Lambda or plain EC2

- **Not Lambda + API Gateway.** Formic is one Next.js server whose agent runs
  keep working after a request returns (`after()` in
  `src/lib/agents/pipeline.ts`), and whose board holds an event stream open.
  Lambda keeps the time limit that the move is meant to remove, and API
  Gateway ends requests at about 30 seconds.
- **Not S3 + CloudFront.** The app renders on the server and has API routes
  and webhooks. S3 only serves static files.
- **Lightsail by default, EC2 when you want standard AWS.** Both are the same
  Ubuntu server running the same scripts. Lightsail is cheaper at this size
  because its price includes the public IPv4 address, the disk and the data
  transfer. EC2 fits better with the rest of AWS (IAM roles, VPCs, RDS,
  Terraform). EC2 has its own section: [On EC2 instead](#on-ec2-instead).

## Cost

Prices last checked October 2026. Check the
[Lightsail pricing page](https://aws.amazon.com/lightsail/pricing/) when you
sign up, and update this table if they have changed.

| Plan (Linux, dual-stack) | Per month | Fit |
| :-- | :-- | :-- |
| 512 MB memory | $5 | Too small. The app, Caddy and a deploy's migrations together outgrow it. |
| **1 GB memory** | **$7** | **Start here.** The same memory as the e2-micro, with the 2 GB swap file `setup.sh` adds. Agent work runs in E2B and GitHub Actions, not on this server. |
| 2 GB memory | $12 | If the app is often swapping (see Resizing below). |

Pick a **dual-stack** plan (IPv4 and IPv6). The cheaper IPv6-only plans cannot
be reached by everyone, and `setup.sh` looks up the server's IPv4 address.

A static IP is free while it is attached to an instance. Snapshots, if you turn
them on, are extra and charged per GB.

**New accounts.** AWS accounts opened since July 2025 choose a Free Plan or a
Paid Plan at sign-up. The Free Plan comes with credits that cover the instance
for months, but AWS **closes the account** after 6 months or when the credits
run out, whichever comes first, and Formic goes offline with it. Upgrade to the
Paid Plan before then; unused credits carry over.

The database runs on the instance and costs nothing extra. E2B and model usage
cost what they did on Vercel.

**The server must be x86.** CI builds the release on an x86 GitHub runner and
ships it with its `node_modules`, native binaries included, so the server runs
exactly what was built. Lightsail instances are x86. On EC2, pick an x86 type
(`t3`), not a Graviton one (`t4g`).

## 1. Account

1. Sign up at https://aws.amazon.com. It asks for a card.
2. Turn on MFA for the root user (**IAM > Dashboard**), then sign in with it
   only for billing and account settings.
3. **Billing and Cost Management > Budgets > Create budget:** a monthly cost
   budget of $15 with email alerts. Anything beyond the instance then shows up
   at once.

## 2. Create the instance

Open https://lightsail.aws.amazon.com and **Create instance**:

- **Region:** the one nearest you and your database. Keeping the app and the
  database in the same region keeps every query fast.
- **Platform:** Linux/Unix. **Blueprint:** OS Only > **Ubuntu 24.04 LTS**.
- **Plan:** Dual-stack, 1 GB ($7). See [Cost](#cost).
- **Name:** `formic`.

Create it and wait for it to show **Running**.

## 3. Networking

On the instance, open the **Networking** tab.

1. **Attach a static IP.** Click **Attach static IP**, create one and attach
   it to `formic`. Do this **before** running `setup.sh`: the script builds the
   HTTPS hostname from the server's IP, and without a static IP the address
   changes whenever the instance stops.
2. **Open HTTPS.** Under **Firewall rules**, SSH (22) and HTTP (80) are open
   by default. Click **Add rule**, pick **HTTPS** (443) and leave it open to
   any IPv4 or IPv6 address. One rule covers both. Caddy needs 80 and 443 to
   get and renew its certificate.

Note the static IP. It stays with you until you release it.

## 4. Set it up

`setup.sh` is the same script the Google Cloud guide uses. Get it onto the
server one of two ways.

**From the browser.** On the instance, click **Connect using SSH**. In the
window that opens:

```bash
nano setup.sh
```

Open `deploy/server/setup.sh` in this repository, copy all of it, and paste it
into the terminal (the clipboard icon at the bottom right of the SSH window
takes text from your computer). Save with Ctrl+O, Enter, Ctrl+X.

**From your computer.** Download the instance's key from **Account > SSH keys**
in Lightsail, then from the repository:

```bash
scp -i ~/Downloads/LightsailDefaultKey-<region>.pem deploy/server/setup.sh ubuntu@<static-ip>:
ssh -i ~/Downloads/LightsailDefaultKey-<region>.pem ubuntu@<static-ip>
```

Either way, on the server:

```bash
sudo bash setup.sh
```

It is safe to run again. It adds swap, installs Node 22, Caddy and Postgres 17,
creates the `formic` database with a nightly backup, creates the `formic` user
and service, writes a starter `/opt/formic/shared/.env`, makes a
deploy key, and prints what to do next, including the private key for GitHub.

It serves on `https://<ip-with-dashes>.sslip.io`, a hostname that resolves to
the IP, so HTTPS works with no DNS. For your own domain, point its A record at
the static IP and run `sudo DOMAIN=formic.example.com bash setup.sh` instead.

## 5. Fill in the environment, connect GitHub, deploy

From here the server is the same as on Google Cloud. Follow these sections of
`docs/google-cloud.md`:

- **4. Fill in the environment.** `sudo -u formic nano /opt/formic/shared/.env`
  and copy the values from Vercel. `FORMIC_SECRET` **must be the same value as
  before**, or every saved key and session becomes unreadable.
- **5. Connect GitHub.** Set `DEPLOY_HOST` to the static IP, `PRODUCTION_URL` to
  the `https://` address, and the `DEPLOY_SSH_KEY` secret to the key
  `setup.sh` printed. Point the GitHub App's callback, setup and webhook URLs
  at the new address.
- **6. Deploy.** **Actions > CI > Run workflow** on `main`.

Then open `https://<your-address>/api/health` and check it reports the commit
you deployed.

## Day to day

Logs, restarts, rollbacks and going back to Vercel are the same as on Google
Cloud: see **Day to day** and **Edge cases worth knowing** in
`docs/google-cloud.md`. The one difference is how you get a shell: **Connect
using SSH** in Lightsail, or `ssh ubuntu@<static-ip>` with the key from step 4.

## Database

`setup.sh` installs Postgres on the instance and creates a `formic` database
reachable only from the server itself. On a fresh `.env` it fills in
`DATABASE_URL`; the same URL, with its generated password, is kept in
`/opt/formic/shared/local-database-url`. Migrations run on every deploy, as
before.

It is sized for the 1 GB plan (about 100 MB of memory). If the app starts
swapping, move up a plan (see Resizing above).

### Moving data from Neon or Supabase

Do this once, on the server. Copying the data out counts as transfer, so a
Neon project over its free allowance must be upgraded first (downgrade again
afterwards) or wait for the monthly reset.

```bash
sudo systemctl stop formic

# The direct (unpooled) connection string from the provider's Connect dialog.
OLD='postgresql://...'
pg_dump --format=custom --no-owner --no-privileges --file /tmp/old.dump "$OLD"
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname "$(sudo cat /opt/formic/shared/local-database-url)" /tmp/old.dump
```

Then `sudo -u formic nano /opt/formic/shared/.env`: set `DATABASE_URL` to the
contents of `/opt/formic/shared/local-database-url`, and delete any
`DATABASE_URL_UNPOOLED`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL` and
`POSTGRES_URL_NON_POOLING` lines, or migrations keep going to the old database.

```bash
sudo systemctl start formic
rm /tmp/old.dump
```

Check `/api/health` and the board, then delete the old project.

### Backups

Two layers, both cheap:

- **Nightly dump.** At 03:30 UTC `pg_dump` writes
  `/var/backups/formic/formic-<date>.dump` and keeps a week. It is on the
  same disk, so it covers mistakes in the data, not a lost instance. Restore
  one with `scripts/restore.sh` (see `docs/runbook.md`).
- **Automatic snapshots.** On the instance's **Snapshots** tab, turn on
  **Automatic snapshots**. A daily copy of the whole disk, database included,
  charged per GB (cents a month at this size). Rebuilding from one is the
  same as Resizing above.

Keep a copy of the `.env` values somewhere safe (a password manager) too.
