# Deploying on Vercel

Vercel hosts Formic as a Next.js app. The app itself is small; the pieces that
need care are the database, the GitHub App URLs, and the fact that a serverless
function is a poor place to run a long agent.

For rollback and restore, `docs/runbook.md` is the operational companion to
this page.

## How a deploy happens

**By hand, and only when you ask.** CI's `deploy` job runs on a manual
dispatch — **Actions → CI → Run workflow**, with `main` selected — and only
after `lint`, `typecheck`, `test` and `build` have passed. A merge runs the
checks and ships nothing.

That is deliberate. Deploying on every merge meant a host that was paused — or
a deploy that failed — could leave a red cross on a pull request and, on a
protected branch, hold up a merge that had nothing to do with shipping.

`vercel.json` turns off Vercel's own Git deploys, so pull requests get no
preview deployment, and the `deploy` job is the only path to production. The
**Vercel GitHub App is not installed on the repository**: that, not this
workflow, is what stops Vercel's own "Account is blocked" check appearing on
every pull request when a plan lapses. Removing its access is a one-time step
in GitHub → the repository → Settings → GitHub Apps.

A manual run needs these three repository secrets, and fails fast without them:

| Secret | Where it comes from |
| :-- | :-- |
| `VERCEL_TOKEN` | A Vercel access token (Account Settings > Tokens) |
| `VERCEL_ORG_ID` | From `.vercel/project.json` after `vercel link` |
| `VERCEL_PROJECT_ID` | Same file |

Each manual deploy costs one deploy against the plan's daily build limit.

## Database

Use a hosted Postgres — Supabase or Neon — and connect it through Vercel's
integration, which sets `POSTGRES_PRISMA_URL` / `POSTGRES_URL` (not
`DATABASE_URL`). Migrations run inside the build. The pooled-vs-direct,
`sslmode`, and baseline details are all in `docs/database.md`; the two that
bite on Vercel specifically:

- **Set `POSTGRES_URL_NON_POOLING`.** Migrations take advisory locks that the
  pooled (PgBouncer) URL cannot hold.
- **Preview builds share production's database and skip migrations.** That is
  deliberate: a PR must never change the schema production is running against.

Watch egress on a free Supabase plan — a busy board can exceed the monthly
allowance and get the database **paused** (see `docs/database.md`). The
board-query fix that cuts that traffic is part of PR #456.

## Environment variables

Fill these in the Vercel project (Production, and Preview where noted):

| Variable | Notes |
| :-- | :-- |
| `DATABASE_URL` *or* `POSTGRES_*` | From the integration. |
| `FORMIC_SECRET` | `openssl rand -base64 32`. **Required** for GitHub sign-in; at least 32 bytes. Changing it signs everyone out and makes saved keys unreadable. |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG` | Turns on GitHub sign-in and per-user tokens. |
| `GITHUB_WEBHOOK_SECRET` | The App's webhook secret. Without it `/api/webhooks/github` answers 503 and handles nothing. |
| `FORMIC_ALLOWED_USERS` | Optional comma-separated allow-list. |
| `FORMIC_URL` | Optional on Vercel: the production address is used when it is empty. |
| `SANDBOX_PROVIDER=e2b` + `E2B_API_KEY` | **Required on Vercel** — see below. |
| `ALERT_WEBHOOK_URL` | Optional; error spikes and a failed smoke test post here. |

A malformed *optional* variable is dropped and listed under `warnings` in
`/api/health` rather than taking the app down. Watch the quoting: pasting
`SANDBOX_PROVIDER="e2b"` verbatim sets the value to `"e2b"` with the quotes;
the code strips one pair, but prefer pasting the bare value.

## GitHub App

Create one at https://github.com/settings/apps/new (or under your org) and set
the URLs to the Vercel production address:

- **Callback URL:** `https://<your-app>/api/auth/github/callback` — plus
  `http://localhost:3000/api/auth/github/callback` for local development.
- **Setup URL:** `https://<your-app>/`, with "Redirect on update" ticked.
- **Webhook:** active, `https://<your-app>/api/webhooks/github`, secret into
  `GITHUB_WEBHOOK_SECRET`.
- **Permissions:** Contents, Pull requests, Issues, Actions, Secrets and
  Workflows read/write; Checks and commit statuses read.
- **Events:** Check run, Check suite, Workflow run, Pull request.

**Preview deployments cannot sign in** — their URLs change per branch, so the
callback can never be registered for them. Test sign-in on production.

Moving the app to a server later (`docs/google-cloud.md`) means changing all
three of those URLs to the new address; until you do, sign-in and webhooks
point at the old one.

## What you cannot do on Vercel

- **The local sandbox cannot run here** — a function has no `git` and a
  read-only filesystem. Set `SANDBOX_PROVIDER=e2b` and `E2B_API_KEY`, or coder
  runs will fail. `/api/health` warns with `LOCAL_SANDBOX_ON_VERCEL` if you
  leave it as `local`.
- **Agent runs are capped by the function's `maxDuration`** — 300 seconds on
  the Hobby plan. Every route that starts a run is limited to that, and a run
  unfinished after ten minutes is failed with a reason on its card rather than
  resuming. This is the main reason the server exists: on a long-running
  server nothing is frozen after a response. An `ANTHROPIC_API_KEY` set on the
  server only matters in local mode; signed in with GitHub, agents run on each
  person's own key on their template.

## Staying under the Hobby allowance

Hobby has no overage: going past an allowance pauses the whole account. Two
things keep Formic under it.

**It costs less.** The board's event stream does not hold a function open on
Vercel: each connection sends what changed and ends, and the browser comes
back 15 seconds later (`STREAM_POLL_MS`). A held stream kept a function alive
for as long as any board was open, which spent the month's function time in
days. The background pollers also stop while a tab is hidden, and the checks
a watched board drives (finished runs, open pull requests, idle cards), which
are the fallback behind GitHub's webhooks, run at most every two minutes.
Active CPU is the allowance that runs out first.

**Boards are told of changes instead of asking** (`src/lib/events/realtime.ts`).
With Supabase Realtime set up, the server broadcasts one empty "changed"
message on a board's channel whenever something happens, and the board
fetches what changed once. An idle board then costs a look every two minutes
(`REALTIME_FALLBACK_MS`) instead of every 15 seconds. No board data goes
through Supabase: the channel name is signed with `FORMIC_SECRET`, and only a
signed-in person is told it. It turns on when these are set (the Supabase
integration for Vercel sets them; redeploy after adding them, since the
browser's allowed addresses are fixed at build time):

| Variable | |
| :-- | :-- |
| `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) | `https://<project>.supabase.co` |
| `SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_ANON_KEY`, or a publishable key) | The public key the browser connects with. |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional. The server sends with it when set. |
| `FORMIC_REALTIME=off` | Turns it off; boards poll every 15 seconds. |

**It refuses work before the line** (`src/lib/usage/governor.ts`). Formic
counts requests, function time and CPU per UTC day in the `platform_usage`
table, and judges them over a rolling 30 days, so it holds whatever day
Vercel's own period starts on. It budgets 70% of each allowance, and a day
may spend a tenth of the 30-day budget.

| Used | What happens |
| :-- | :-- |
| under 85% | Everything works. |
| 85% | New work is refused (changes through the API, the event stream) with a 503. Reading the board, webhooks and runner reports still work, so runs already going can finish. |
| 100% | Everything but `/api/health` answers 503 until 00:00 UTC. |

`/api/health` (signed in) shows the counts under `hostUsage`. Compare them
with the Usage dashboard now and then; Formic's figures are its own estimate,
not Vercel's meter.

| Variable | Default | |
| :-- | :-- | :-- |
| `FORMIC_USAGE_LIMITS` | on on Vercel | `on` or `off` to force it either way. |
| `FORMIC_USAGE_SHARE` | `0.7` | The share of each Hobby allowance to budget. Lower it if the dashboard runs ahead of `hostUsage`. |
| `FORMIC_EVENTS` | `poll` on Vercel | `stream` holds the event stream open, as on a server. |

## After a merge

The `smoke-test` workflow waits for the deploy to serve the merged commit,
then checks `/api/health` and `/`. It needs the **`PRODUCTION_URL` repository
variable** (set it to `https://<your-app>`); without it the workflow skips.
`/api/health` reports the commit from `VERCEL_GIT_COMMIT_SHA`, and the smoke
test waits for that SHA to appear before it trusts the response, so it never
checks the previous deploy. Set `ALERT_WEBHOOK_URL` (same value as the app's)
so a failure pages you instead of only failing the run.

## Common failures

| Symptom | Cause |
| :-- | :-- |
| Deploy job fails at "Check the Vercel secrets are set" | `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` missing. |
| Build fails in `db-push.sh` | A migration references a missing column, or an applied migration was edited. The build log names which. |
| `P3005` on the first deploy | The database predates migrations; the script marks `20260925000000_init` applied and retries. |
| Every runtime query fails with a TLS error after a schema push | The pooled URL's `sslmode`; handled in `client.ts` (`docs/database.md`). |
| `/api/health` reports `ok: false` with a `databaseError` | The database is paused (often egress) or unreachable. |
| Sign-in bounces with "Sign-in expired" | The GitHub App callback/setup URLs do not point at this deployment, or `FORMIC_SECRET` changed. |
| `/api/health` warns about the local sandbox | `SANDBOX_PROVIDER` is not `e2b`. |
