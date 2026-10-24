# Formic

An autonomous agent Kanban board: from a backlog idea to a merged pull
request, with agents doing the middle.

Moving a card triggers the agent for its column. A Product Agent turns a
request into a PRD, an Architect Agent splits it into tickets with separate
file scopes, Coder Agents build them in sandboxes, a Reviewer Agent drives CI
and the merge, and a PM Agent writes the showcase.

## Run it

```bash
npm install
npm run dev
```

No database or API key needed. The board starts on an in-memory store with
demo data. Set `AGENT_PROVIDER=mock` to run the whole pipeline with mock
agents and a mock GitHub, so nothing leaves your machine.

For real use, copy `.env.example` to `.env`. Each variable switches on one
layer, and nothing breaks without it:

| Variable | Switches on |
| :-- | :-- |
| `DATABASE_URL` (or Vercel's `POSTGRES_*`) | Durable state |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG` | GitHub sign-in; each person works on their own repos with their own keys |
| `FORMIC_SECRET` | Encryption for saved keys and sessions. Set it before anyone signs in. |
| `GITHUB_WEBHOOK_SECRET` | CI results driving the fix-or-merge loop |
| `SANDBOX_PROVIDER=e2b` + `E2B_API_KEY` | Isolated sandboxes. Required on Vercel. |
| `FORMIC_ALLOWED_USERS` | An allow-list of GitHub usernames |
| `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` | Local mode only: one user, no sign-in |

With a database:

```bash
npm run db:local     # throwaway local Postgres, prints a DATABASE_URL
npm run db:push      # apply the schema
npm run db:seed      # demo board
npm run dev
```

`GET /api/health` shows which layers are live, plus the build id and any
config warnings.

## Deploy

Deploys are manual. Merging to `main` runs the checks and ships nothing.

1. On GitHub, open **Actions → CI → Run workflow**, pick `main`, and run it.
2. The `deploy` job runs once lint, typecheck, test and build pass. Vercel
   then builds production and applies migrations.
3. Watch it under **Actions → CI**. The newest run sits at the top.
4. The `Production smoke test` workflow then checks `/api/health` and `/`.

Rollback and restore: [`docs/runbook.md`](docs/runbook.md).

| Where | Guide | Good for |
| :-- | :-- | :-- |
| Vercel | [`docs/vercel.md`](docs/vercel.md) | Always on, multi-user. Includes GitHub App setup. |
| Google Cloud | [`docs/google-cloud.md`](docs/google-cloud.md) | No function time limit. Set `DEPLOY_HOST` to deploy over SSH. |
| AWS Lightsail | [`docs/aws.md`](docs/aws.md) | The same server setup on AWS, at a fixed monthly price. |
| Your machine | [`docs/local.md`](docs/local.md) | Free, single user. `deploy/mac/` builds a Mac app. |

## Scripts

| Command | Does |
| :-- | :-- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run lint` / `npm run typecheck` | ESLint and `tsc --noEmit` |
| `npm test` | Unit and component tests |
| `npm run test:e2e` | End-to-end tests in a real browser |
| `npm run db:migrate` | Create a migration in development |
| `npm run db:backup` / `db:restore` | Back up or restore the database |

## Docs

| Topic | Doc |
| :-- | :-- |
| Agents, CLI agents, the assistant, GitHub issues, webhooks | [`docs/how-it-works.md`](docs/how-it-works.md) |
| Many agents and people on one repo | [`docs/concurrency.md`](docs/concurrency.md) |
| Where agent work runs | [`docs/agent-execution.md`](docs/agent-execution.md) |
| Engines and packages per project (Node, Python, Godot) | [`docs/toolchains.md`](docs/toolchains.md) |
| Database, migrations, backups | [`docs/database.md`](docs/database.md) |
| Security | [`docs/security.md`](docs/security.md) |
| Limits and run time budgets | [`docs/limits.md`](docs/limits.md), [`docs/run-time-budgets.md`](docs/run-time-budgets.md) |
| Tokens used and saved | [`docs/token-usage.md`](docs/token-usage.md), [`docs/token-efficiency.md`](docs/token-efficiency.md) |
| Colony: reserve and scouts | [`docs/colony.md`](docs/colony.md) |
| Testing | [`docs/testing.md`](docs/testing.md) |
| UI design | [`design/DESIGN.md`](design/DESIGN.md) |

## Layout

```
design/          UI brief and artboards
docs/            Guides (above)
e2e/             End-to-end tests
prisma/          Schema, migrations, seed
src/app/         Routes and API handlers
src/components/  UI
src/lib/
  domain/        Rules: status, file scopes, DAG. No I/O, most tests.
  agents/        Agent ports, pipelines, prompts
  coder/         Checkout, commit, push, pull request
  review/        Webhook, fix-or-merge loop, merge lane
  runner/        CLI agents in the repo's GitHub Actions
  colony/        Levels, scouts, reserve
  toolchains/    What each kind of project needs set up, and its checks
  db/  vcs/  sandbox/  events/  budget/  usage/  secrets/
```
