# The database

All three ways to run Formic — Vercel, a Google Cloud server, and your own
machine — share one database story. This page is the part that is the same
everywhere; the deploy guides link here instead of repeating it.

Formic runs without a database: the board then lives in an in-memory store
seeded with demo data (`src/lib/db/index.ts`). Everything below only applies
once a connection string is set.

## Which variable wins

`src/lib/db/client.ts` and `prisma.config.ts` resolve the connection in this
order, first one set wins:

1. `DATABASE_URL`
2. `POSTGRES_PRISMA_URL`
3. `POSTGRES_URL`

Vercel's Supabase and Neon integrations do not set `DATABASE_URL`; they set
the `POSTGRES_*` names, which is why the fallback exists. On a server or a
laptop you set `DATABASE_URL` yourself.

A value pasted verbatim from `.env.example`'s `KEY="value"` syntax carries the
quotes with it. Both `client.ts` and `src/lib/secrets/env.ts` strip one
matching pair, so `"postgresql://…"` pasted into a UI field still works — but
only one pair, so don't paste it already quoted.

## Direct connections, and pooled ones

Migrations have one extra rule: they need a **direct** connection. Supabase's
pooled URL (PgBouncer, transaction mode) does not support the advisory locks
`prisma migrate deploy` takes. `scripts/db-push.sh` therefore swaps
`POSTGRES_URL_NON_POOLING` in for `DATABASE_URL` when it is present. If you
have only the pooled string set, the first migration fails with a lock error
— copy the direct string Supabase shows next to the pooled one.

At runtime the pooled URL is fine, and preferred: the app opens a pool per
process (`globalThis.__formicPrisma`), not a connection per query.

## SSL, and the `sslmode=require` trap

`db push`'s engine and the `pg` driver disagree about `sslmode=require`.
Prisma's engine treats it as libpq does — "encrypt, don't verify the chain" —
while `node-postgres` now aliases it to `verify-full`. Against Supabase, whose
chain is not in Node's default CA bundle, that makes a schema push succeed and
every runtime query fail with a TLS error. `src/lib/db/client.ts` handles it:
for a URL that asks for SSL it drops `sslmode` from the string itself (an
`ssl` option passed alongside would be overwritten by the re-parsed URL) and
sets `rejectUnauthorized: false`. A local, SSL-less Postgres is untouched.

## Migrations

- They are committed under `prisma/migrations/` and applied with
  `prisma migrate deploy`, which is `scripts/db-push.sh`: it runs inside
  `npm run build` on Vercel, and directly on the server before a release
  switches. It never generates a migration from the current schema.
- **Only production migrates.** Vercel scopes the database variables to both
  Production and Preview, and preview builds read the *same* database, so
  `db-push.sh` skips anything whose `VERCEL_ENV` is not `production`. A PR's
  build must never change the schema production is running against.
- `migrate deploy` only moves forward, and it checksums what it applied: edit
  or delete an already-applied migration and it refuses to run. To undo a
  schema change, write a *new* migration that reverses it.
- A database first built with `prisma db push` has the schema but an empty
  migration history, and `migrate deploy` declines it with `P3005`.
  `db-push.sh` catches exactly that, marks the baseline
  `20260925000000_init` as applied **once**, and carries on. A fresh database
  (staging, a rebuilt server) just runs the migrations for real.

Prefer additive, backward-compatible migrations — add a column, don't rename
or drop one in the same change — so the previous release still runs against
the new schema. That is what makes an application rollback safe without a
schema rollback. `docs/runbook.md` has the full deploy/rollback/restore drill.

## Seeding

The server seeds the demo board the first time it finds a database with no
epics in it (`seedIfEmpty` in `src/instrumentation.ts`), and never again —
it checks the epic count first, so real work is never at risk from a restart.
The same fixture backs `npm run db:seed`. On the in-memory store the demo
board is seeded at import time.

This is why a brand-new database shows the demo board rather than an empty
one, and why an existing database keeps exactly the boards that are in it.

## Egress, and why a free database gets expensive

The board is read on every refresh, transition and sweep, and each row's long
text (an Epic's request and PRD, a ticket's description and criteria) was
being loaded on every one of those reads even though no card shows it. On the
Supabase free plan that was most of the monthly egress — around 18 GB against
a 5 GB allowance. `boardCards` now selects only the fields a card is built
from, which is the single largest cut to that traffic.

Two consequences worth knowing:

- A free Supabase project can exceed its egress allowance and be **paused**
  until the billing cycle resets, taking the board down with it. If that
  happens, the fix is to restore egress (upgrade, or wait for the reset) —
  there is nothing to change in the app.
- Moving Formic's *own* database onto whichever machine runs it (see
  `docs/local.md`) removes this entirely, because the database traffic never
  leaves the machine.

## Backups and restore

Point-in-time recovery is the provider's job: Supabase, Neon and RDS all
offer continuous, WAL-based PITR. Turn it on for production in the provider's
console; this repo cannot configure it from outside.

`scripts/backup.sh` and `scripts/restore.sh` make and load an on-demand
logical backup (`pg_dump`/`pg_restore`) — for a snapshot before a risky
migration, and for rehearsing a restore. `restore.sh` drops and recreates
every table the dump contains, so never point it at production; rehearse on
staging. The drill is in `docs/runbook.md`.
