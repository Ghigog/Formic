# Hosting on Oracle Cloud

Formic runs on one Oracle Cloud Always Free VM: Node serves the app, Caddy
puts HTTPS in front of it, and CI deploys every green commit on `main` over
SSH. The database stays where it is (Supabase or Neon); only the app moves.

On a long-running server nothing is frozen after a response, so agent runs
are no longer capped by a function's `maxDuration`.

## 1. Create the VM

In the Oracle Cloud console, **Compute > Instances > Create instance**:

- **Image:** Canonical Ubuntu 24.04.
- **Shape:** Ampere, `VM.Standard.A1.Flex`, 4 OCPUs and 24 GB (the whole
  Always Free allowance). The 1 GB AMD micro shape cannot run `next build`.
- **Networking:** a public subnet, "Assign a public IPv4 address" on.
- **SSH keys:** paste your own public key.

"Out of capacity" for A1 is common on free accounts. Upgrading the account to
Pay As You Go fixes it and stays free within the Always Free limits.

Then open the web ports: **Networking > Virtual cloud networks >** your VCN
**> Security Lists > Default** > Add ingress rules: source `0.0.0.0/0`, TCP,
destination ports `80,443`.

## 2. Set it up

From the repository, on your own machine:

```bash
ssh ubuntu@<public-ip> 'sudo bash -s' < deploy/oracle/setup.sh
```

It installs Node 22 and Caddy, opens the VM's own firewall, creates a
`formic` user and service, and serves on `https://<ip-with-dashes>.sslip.io`
(a hostname that resolves to the IP, so HTTPS works with no DNS). With your
own domain, point its A record at the VM and pass `DOMAIN=` (see the script's
header). It ends by printing what to do next, including a deploy key.

## 3. Fill in the environment

```bash
ssh ubuntu@<public-ip>
sudo -u formic nano /opt/formic/shared/.env
```

Copy the values from the Vercel project's environment variables
(`vercel env pull` writes them to a file). `FORMIC_URL` is already set to the
new address; Vercel used to fill that in on its own.

## 4. Connect GitHub

- **Actions secrets and variables** on this repository: variable
  `DEPLOY_HOST` (the VM's IP), variable `PRODUCTION_URL` (the new
  `https://` address, for the smoke test), secret `DEPLOY_SSH_KEY` (the key
  the setup script printed). With `DEPLOY_HOST` set, CI's `deploy` job goes
  to the VM instead of Vercel.
- **The GitHub App:** change the callback URL, setup URL and webhook URL to
  the new address.

## 5. Deploy

Re-run the CI workflow on the latest `main` commit, or merge anything. The
`deploy` job uploads the commit to `/opt/formic/releases/<sha>`, builds it
there (running migrations, as Vercel's build did), switches
`/opt/formic/current` to it and restarts. A failed build leaves the running
release alone. `/api/health` then reports the new commit.

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
