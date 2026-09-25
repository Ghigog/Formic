# Runbook: deploy, roll back, restore

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
4. Merge to `main`. Once CI's `build` and `e2e` pass, its `deploy` job has
   Vercel build and deploy production, running
   `scripts/db-push.sh` (`prisma migrate deploy`) before `next build`. A
   migration that references a column or table that doesn't exist yet, or
   whose file was edited after being applied, fails the build instead of
   running — the build log says which migration and why.
5. Confirm `/api/health` on production and watch the post-merge smoke test.

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
