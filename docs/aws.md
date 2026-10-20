# Hosting on AWS Lightsail

Formic runs on an AWS **Lightsail** instance the same way it runs on Google
Cloud's e2-micro: Node serves the app, Caddy puts HTTPS in front of it, and a
manual CI run builds the app and ships it over SSH. The database stays where it
is (Supabase or Neon); only the app moves.

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
| 1 GB memory | $7 | Works, like the e2-micro, with the 2 GB swap file `setup.sh` adds. |
| **2 GB memory** | **$12** | **Recommended.** Agent runs fit without leaning on swap. |

Pick a **dual-stack** plan (IPv4 and IPv6). The cheaper IPv6-only plans cannot
be reached by everyone, and `setup.sh` looks up the server's IPv4 address.

A static IP is free while it is attached to an instance. Snapshots, if you turn
them on, are extra and charged per GB.

**New accounts.** AWS accounts opened since July 2025 choose a Free Plan or a
Paid Plan at sign-up. The Free Plan comes with credits that cover the instance
for months, but AWS **closes the account** after 6 months or when the credits
run out, whichever comes first, and Formic goes offline with it. Upgrade to the
Paid Plan before then; unused credits carry over.

Everything else costs what it does on Vercel: the database, E2B and model usage
do not change.

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
- **Plan:** Dual-stack, 2 GB ($12). See [Cost](#cost).
- **Name:** `formic`.

Create it and wait for it to show **Running**.

## 3. Networking

On the instance, open the **Networking** tab.

1. **Attach a static IP.** Click **Attach static IP**, create one and attach
   it to `formic`. Do this **before** running `setup.sh`: the script builds the
   HTTPS hostname from the server's IP, and without a static IP the address
   changes whenever the instance stops.
2. **Open HTTPS.** Under **IPv4 Firewall**, SSH (22) and HTTP (80) are open by
   default. Click **Add rule** and add **HTTPS** (443). Do the same under
   **IPv6 Firewall**. Caddy needs both 80 and 443 to get and renew its
   certificate.

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

It is safe to run again. It adds swap, installs Node 22 and Caddy, creates the
`formic` user and service, writes a starter `/opt/formic/shared/.env`, makes a
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

**Backups.** The app keeps no state on the server beyond `/opt/formic/shared/.env`,
so a lost instance is rebuilt by repeating steps 2 to 5. Keep a copy of the
`.env` values somewhere safe (a password manager). Lightsail's automatic
snapshots are optional and cost extra.

**Resizing.** Lightsail cannot change an instance's plan in place. Take a
snapshot, create a larger instance from it, and move the static IP across. The
address, and so the HTTPS hostname and `DEPLOY_HOST`, stay the same.

## On EC2 instead

The same server on plain EC2. Choose it when the app should live alongside
other AWS resources (RDS, IAM roles, a VPC) or be managed in Terraform. It
costs more at this size, and the bill varies with traffic.

| Item (us-east-1) | Per month |
| :-- | :-- |
| `t3.small` (2 vCPU, 2 GB), on demand | about $15.20 |
| Elastic IP (every public IPv4 address is charged) | about $3.65 |
| 20 GB `gp3` disk | about $1.60 |
| Data out, past the first 100 GB | $0.09 per GB |
| **Total** | **about $20.50** |

Prices last checked October 2026. A one-year Savings Plan lowers the instance
line by roughly a third.

Steps 1 (account and budget) and 5 onward are the same as for Lightsail. Steps
2 to 4 become:

### Launch the instance

**EC2 > Instances > Launch instances:**

- **Name:** `formic`.
- **AMI:** Ubuntu Server 24.04 LTS, **64-bit (x86)**.
- **Instance type:** `t3.small`. Not `t4g`: see "The server must be x86" above.
- **Key pair:** create one (ED25519, `.pem`) and keep the file. It is how you
  log in as `ubuntu`.
- **Network settings:** create a security group that allows **SSH**, **HTTP**
  and **HTTPS** from anywhere (`0.0.0.0/0`). SSH has to be open to anywhere,
  not "My IP": CI deploys over SSH from GitHub's runners, whose addresses
  change. Ubuntu's AMI only accepts keys, never passwords.
- **Storage:** 20 GiB, `gp3`.

### Give it a fixed address

**EC2 > Elastic IPs > Allocate Elastic IP address**, then **Actions >
Associate** it with `formic`. Do this **before** `setup.sh`, for the same
reason as the static IP on Lightsail: the HTTPS hostname is built from the IP.

### Set it up

From the repository on your computer:

```bash
scp -i formic.pem deploy/server/setup.sh ubuntu@<elastic-ip>:
ssh -i formic.pem ubuntu@<elastic-ip>
sudo bash setup.sh
```

Or use **Connect > EC2 Instance Connect** in the console and paste the script
into `nano setup.sh`, as in the Lightsail step. Then continue at
[step 5](#5-fill-in-the-environment-connect-github-deploy).

### In Terraform

The whole server is three resources: `aws_instance`, `aws_security_group` and
`aws_eip`, plus `aws_eip_association`. `setup.sh` stays as it is; it can run
as the instance's `user_data`, though then its closing output (with the deploy
key) goes to the system log instead of your terminal.

### Moving from Lightsail to EC2 later

Lightsail can export a snapshot to EC2: **Snapshots > Export to Amazon EC2**,
then launch an instance from the resulting AMI in the EC2 console. The new
instance gets a new IP, so update `DEPLOY_HOST`, `FORMIC_URL`,
`PRODUCTION_URL` and the GitHub App URLs, or use your own domain from the start
and only move its A record.
