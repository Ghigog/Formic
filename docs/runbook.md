# Runbook: deploy, roll back, restore

> **Production is on AWS Lightsail** (https://52-200-209-60.sslip.io), deployed
> over SSH by `deploy/server/deploy.sh`, with Postgres on the same server. The
> Vercel steps below apply only to a Vercel deployment. For the server see
> [`aws.md`](aws.md) and [`../AGENTS.md`](../AGENTS.md).

Formic has one production database and, once set up (see below), one staging
database. Vercel builds run `scripts/db-push.sh`, which applies committed
migrations with `prisma migrate deploy` — see `prisma.config.ts` for how the
connection is resolved. Preview builds (PRs) skip migrations entirely; they
read the same database as production, so a PR's build must never change its
schema. Migrations only ever run in a project's production environment,
which is what makes a separate staging Vercel project (its own production
environment, its own database) work with this script unchanged.

## Deploy

1. Write the code change and, if it touches `prisma/schema.prisma`, a
   migration for it:
   ```bash
   npm run db:local        # throwaway local Postgres, prints a DATABASE_URL
   DATABASE_URL=<printed url> npm run db:migrate -- --name <what-changed>
   ```
   This writes `prisma/migrations/<timestamp>_<what-changed>/migration.sql`
   and applies it locally. Commit the migration alongside the schema change.
   Prefer additive, backward-compatible migrations (add a column, don't
   rename or drop one in the same change) so the previous release can still
   run against the new schema — that's what makes an application rollback
   safe without a schema rollback.
2. Open a PR. CI pushes the schema to its own throwaway Postgres and runs the
   test suite against it; this does not touch staging or production.
3. On staging first: merge to the branch staging deploys from (or promote
   the same commit there, depending on how staging is wired — see below).
   Confirm `/api/health` reports `ok: true` and spot-check the board.
4. Merge to `main`. Nothing deploys on a merge: the `deploy` job runs only
   from **Actions → CI → Run workflow** on `main`, and only once every check
   above it has passed. Run it when you mean to ship. Vercel then builds and
   deploys production, running `scripts/db-push.sh` (`prisma migrate deploy`)
   before `next build`. A migration that references a column or table that
   doesn't exist yet, or whose file was edited after being applied, fails the
   build instead of running — the build log says which migration and why.
5. Confirm `/api/health` on production and watch the smoke test.

## Roll back

**Application only (most rollbacks).** Revert the commit, or in the Vercel
dashboard promote the previous deployment back to production. Safe on its
own as long as every migration since the last good release was additive —
the old code never queries a column or table that stopped existing.

**Schema needs to go back too.** `prisma migrate deploy` only ever moves
forward; there is no automatic down-migration. Write a new migration that
undoes the change (drop the added column, re-add the removed one) and deploy
it the normal way, through a PR. Never edit or delete an already-applied
migration file — `migrate deploy` checksums applied migrations and refuses to
run if one changed.

**The forward migration already destroyed data.** Stop deploys, then use the
restore drill below against the production database, restoring the most
recent backup from before the bad migration ran.

## Restore

Point-in-time recovery is the hosting provider's job — Supabase, Neon and RDS
all offer continuous, WAL-based PITR to any second in the retention window.
Turn it on for the production database in the provider's dashboard; this
repo can't configure it from outside. `scripts/backup.sh` and
`scripts/restore.sh` make an on-demand logical backup and load it back, for
a manual snapshot before a risky migration and for rehearsing this drill.

**Rehearse the drill on staging** (never on production):

```bash
# 1. Take (or fetch, from the provider's PITR console) a backup of production.
DATABASE_URL=<production, read-only if possible> npm run db:backup -- /tmp/formic-yesterday.dump

# 2. Load it into staging. This drops and recreates every table the dump
#    contains — never point it at production.
DATABASE_URL=<staging> npm run db:restore -- /tmp/formic-yesterday.dump

# 3. Confirm the board matches: open staging, or compare row counts/content
#    directly, e.g.
psql "<staging DATABASE_URL>" -c 'select id, title, status from epic order by id;'
```

**Actually restoring production** after data loss: use the provider's PITR
console to restore to a new database at the timestamp just before the bad
change, point `DATABASE_URL` at it (or restore in place, if the provider
supports that), then confirm with the same query as step 3 before letting
traffic back in.

## Setting up staging

A staging environment is a second Vercel project pointed at this repository,
with its own database:

1. In Vercel, create a new project from the same GitHub repository (or add a
   second production branch to this one, if using Vercel's Git branch
   deploy targets) — its own project keeps its environment variables,
   deployments and daily build quota separate from production.
2. Provision a separate Postgres database for it (a second Supabase or Neon
   project, or another database on the same instance) and set its
   `DATABASE_URL` (or `POSTGRES_PRISMA_URL`/`POSTGRES_URL`/
   `POSTGRES_URL_NON_POOLING`) in that project's environment variables. Set
   `FORMIC_SECRET` to a value distinct from production's.
3. Deploy it. The first build runs `prisma migrate deploy` against the new,
   empty database, applying every committed migration from scratch.
4. From then on, deploy to staging before production (see Deploy above) so a
   migration is proven there first.

## Adopting migrations on the existing production database

Production's schema was created by `prisma db push`, not by a migration, so
its history is empty. Before the first `migrate deploy` runs against it,
mark the baseline migration as already applied — it must not try to
`CREATE TABLE` over existing tables:

```bash
DATABASE_URL=<production> npx prisma migrate resolve --applied 20260925000000_init
```

This is a one-time step for the current production database. A fresh
database (staging, or a rebuilt production) just runs `migrate deploy`
normally, applying that migration for real.

## Monitoring

What watches production, so you know which alert you are looking at. On
Lightsail all of it reads the same `/api/health` on
https://52-200-209-60.sslip.io.

- **Scheduled health probe**
  (`.github/workflows/health-probe.yml`). Every 15 minutes it requests
  `$PRODUCTION_URL/api/health`, retrying three times about 20 seconds apart.
  If it still does not get HTTP 200 with `ok: true`, the job fails and posts
  to `ALERT_WEBHOOK_URL`. This is the uptime monitor; there is no external
  one.
- **Post-deploy smoke test** (`.github/workflows/smoke-test.yml`). After each
  deploy it checks that `/api/health` is healthy and reports the commit that
  was just deployed, and alerts to `ALERT_WEBHOOK_URL` if not.
- **Error-spike alerts.** When the server logs 10 errors within 5 minutes it
  posts to `ALERT_WEBHOOK_URL`, then stays quiet for 15 minutes. The count is
  kept per server process; on the one Lightsail instance that is all of them.
- **Recovery clock.** The server looks for orphaned runs when it starts and
  then every 5 minutes. A run still live after `ORPHAN_AFTER_MS` (10 minutes)
  is failed, so a run whose worker died is failed within 15 minutes of going
  live. See [Ticket stuck after a worker restart](#ticket-stuck-after-a-worker-restart).

Things to know about the GitHub-side checks:

1. `PRODUCTION_URL` must be set (Settings → Secrets and variables → Actions →
   Variables). If it is not, the probe fails loudly instead of passing.
2. `ALERT_WEBHOOK_URL` is an Actions secret and the server's `.env` value of
   the same name feeds the spike alerts. Without it, alerts only reach the
   job log or the server log.
3. GitHub runs scheduled workflows only from the default branch (`main`),
   may start them several minutes late, and disables them after 60 days
   without repository activity. If probe alerts stop, check Actions for a
   "disabled" banner and re-enable the workflow, or run it once by hand
   (Actions → Production health probe → Run workflow).

## Incident playbooks

### Database unreachable

The alert says `/api/health` returned HTTP 503 with `database: unreachable`
(or no answer at all). On Lightsail, Postgres runs on the same instance as the
app.

1. Open the health report: `curl -s https://52-200-209-60.sslip.io/api/health`.
   The public answer has `ok`, `commit` and `database`. Signed in, the same
   URL also shows `databaseError` and the rest. `database: unreachable` means
   the server is up but cannot reach Postgres. No answer at all means the app
   or Caddy is down: go to step 6.
2. SSH to the instance (**Connect using SSH** in Lightsail, or
   `ssh ubuntu@<static-ip>`) and check Postgres:
   ```bash
   sudo systemctl status postgresql --no-pager
   sudo -u postgres psql -d formic -tAc 'select 1'
   ```
3. If Postgres is stopped, start it: `sudo systemctl restart postgresql`. If
   it will not start, read why: `sudo journalctl -u postgresql -n 100
   --no-pager`. Check the disk (`df -h`) and memory (`free -m`) first; a full
   disk or an out-of-memory kill is the usual cause on the 1 GB plan. If it
   keeps swapping, move up a plan (see `docs/aws.md`, Resizing).
4. If Postgres is up, `DATABASE_URL` in `/opt/formic/shared/.env` may be
   wrong. It should match `/opt/formic/shared/local-database-url`.
5. Restart the app so it opens fresh connections:
   `sudo systemctl restart formic`.
6. Check the app and Caddy: `sudo systemctl status formic caddy --no-pager`,
   and the app log: `sudo journalctl -u formic -n 100 --no-pager`.
7. Confirm `/api/health` shows `ok: true` and `database: postgres`. The next
   probe, within 15 minutes, goes green by itself.
8. If the data itself is damaged, stop and use [Restore](#restore).

On a Vercel deployment, the database is the provider's (Supabase, Neon): check
its dashboard and `DATABASE_URL` in the project's environment variables.

### Ticket stuck after a worker restart

A ticket sits in a working column (or shows a run in progress) long after the
server restarted or a deploy went out, and nothing is happening. A deploy
restarts `formic`, and any run it was doing is lost.

1. Wait for the recovery clock first. It runs every 5 minutes and fails any run
   still live after `ORPHAN_AFTER_MS` (10 minutes), so within about 15 minutes
   of the run going live the run is marked failed, and the ticket is marked
   failed with the reason "The worker restarted while this run was in flight.
   Nothing was pushed; move the card back to To Do to try again."
2. Check the app is running and the clock is not blocked:
   `sudo systemctl status formic --no-pager`, then
   `sudo journalctl -u formic --since "1 hour ago" --no-pager | grep -i 'orphan\|recovery'`.
   A line "failed N run(s) orphaned by a restart" means it worked. "orphan
   recovery skipped" means the database was unreachable: see
   [Database unreachable](#database-unreachable).
3. Once the card shows the failed reason, move it back to **To Do** on the
   board. Nothing was pushed by the lost run, so it starts clean.
4. If it is still stuck after 15 minutes, restart the app
   (`sudo systemctl restart formic`). Starting the server looks for orphans
   straight away.
5. Check `/api/health` (signed in) for `activeRuns`. If it is `0` while the
   board shows a run, the run is gone and step 1 applies.

### GitHub webhooks not delivering

Pull requests merge or close on GitHub but the board does not follow, or
GitHub shows failed deliveries.

1. Check the server side: sign in and open `/api/health`. `webhook:
   unconfigured` means `GITHUB_WEBHOOK_SECRET` is not set, and the endpoint
   answers 503 to every delivery. Set it in `/opt/formic/shared/.env`
   (`sudo -u formic nano /opt/formic/shared/.env`), the same value as the
   GitHub App's webhook secret, then `sudo systemctl restart formic`.
2. In GitHub, open the App's settings (Settings → Developer settings →
   GitHub Apps → your app → **Advanced**), or the repository's webhook
   (Settings → Webhooks), and look at **Recent Deliveries**.
3. Read the response code:
   - **503**: the secret is missing on the server (step 1).
   - **401**: the secret differs between GitHub and `.env`. Make them equal.
   - **Timeout or connection refused**: the app or Caddy is down. Check
     `sudo systemctl status formic caddy --no-pager`, then
     [Database unreachable](#database-unreachable) step 6.
   - **202 with ignored**: the event is not one Formic acts on. This is normal.
4. Confirm the payload URL is `https://52-200-209-60.sslip.io/api/webhooks/github`.
   A changed address (for example after a new instance or static IP) breaks
   delivery.
5. After fixing it, open a failed delivery and click **Redeliver**. Deliveries
   are signed and handled once each, so redelivering is safe. Missed events
   older than 3 days cannot be redelivered; move the card by hand instead.
