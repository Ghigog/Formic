# Formic

An autonomous agent Kanban platform: backlog idea to merged PR, with agents
doing the middle.

Cards move across five columns, and specific column transitions trigger
sandboxed backend work. A Product Agent expands a raw request into a PRD; an
Architect Agent decomposes it into tickets with isolated file scopes; Coder
Agents implement them in ephemeral sandboxes; a Reviewer Agent drives CI and
merge; a PM Agent writes the showcase.

## Running it

```bash
npm install
npm run dev
```

That works with no configuration: no database and no API key. The board runs
on an in-memory store seeded with demo data, and the agent pipelines run on
mock implementations that stream and take a plausible amount of time. State
survives a browser reload, not a server restart.

For the real thing, copy `.env.example` to `.env` and fill in what you need.
Each credential unlocks one layer and nothing breaks without it:

| Variable | Unlocks |
| :-- | :-- |
| `DATABASE_URL` (or `POSTGRES_PRISMA_URL` / `POSTGRES_URL`, as set by Vercel's Postgres integrations) | Durable state. Without it, the in-memory store. |
| `ANTHROPIC_API_KEY` | Real agents. Without it, mocks. |
| `GITHUB_TOKEN` | Cloning and pushing, and the list of repositories in the picker. `GITHUB_REPO` sets the board's default project. |
| `E2B_API_KEY` + `SANDBOX_PROVIDER=e2b` | Isolated sandboxes. Without it, local child processes. |
| `GITHUB_WEBHOOK_SECRET` | CI results driving the fix-or-merge loop. |

```bash
npm run db:local     # throwaway local Postgres, prints a DATABASE_URL
npm run db:push      # apply the schema
npm run db:seed      # demo board
npm run dev
```

`GET /api/health` reports which of those layers are live, plus the build id.

## Picking a repository

The repository button in the header switches the board to another
repository, like choosing one in Claude Code on the web. It lists everything
`GITHUB_TOKEN` can reach (a fine-grained token scoped to a few repositories
lists just those), and takes a typed `owner/repo` too. Each repository gets
its own board, created empty the first time it is picked. The choice is per
browser. The demo board stays under the default project.

## Deploying on Vercel

- **Schema.** Production builds apply the schema (`scripts/db-push.sh`).
  Preview builds skip it, since they share production's database. A change
  that would drop data fails the build instead of running; apply it by hand.
- **Seed.** The server seeds the demo board the first time it finds a
  database with no epics, and never again after that.
- **Config.** A malformed optional variable is ignored and listed under
  `warnings` in `/api/health`; it no longer takes the app down.
  `GITHUB_REPO` accepts `owner/repo` or the repository URL.
- **Agent runs** continue after the request returns (`after()`), up to the
  function's max duration: 300 seconds on the Hobby plan. A run still
  unfinished after 10 minutes is failed with a reason on its card.
- **Sandboxes.** The local provider can't run on Vercel. Use
  `SANDBOX_PROVIDER=e2b` with `E2B_API_KEY` for coder runs.
- **Checks.** CI builds and boots the app against a real Postgres on every
  PR. After each merge, the smoke test waits for that commit to go live and
  checks `/api/health` and `/` (set the `PRODUCTION_URL` repo variable).

## Scripts

| Command | Does |
| :-- | :-- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Domain and component tests (node + jsdom) |
| `npm run test:e2e` | End-to-end tests in a real browser |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:local` | Start a local Postgres for development |
| `npm run db:push` / `db:seed` | Apply schema, load demo data |
| `npm run serve` | Start the built app and verify the running build id |

## Design

`design/DESIGN.md` is the UI brief and `design/artboards/` holds the rendered
mockups — self-contained HTML, no build step, open them in a browser. The
artboard wins wherever it and the brief disagree. Every colour, radius and
font in the app comes from the token layer in `src/app/globals.css`, which is
lifted from `design/artboards/Main.html`; components reference tokens, never
raw hex.

## Layout

```
design/              UI brief and the rendered artboards
docs/tasks/          Ticket specs, one file per PROT-xx
e2e/                 End-to-end tests and their page helpers
prisma/              Schema and seed
src/app/             Routes and API handlers
src/components/      board/ and ui/
src/lib/
  domain/            Status, file scopes, DAG, events, contracts. No I/O.
  db/                Repository interface; Prisma and in-memory
  agents/            Ports, mocks, Anthropic implementations, pipelines
  coder/             Checkout, commit, push, pull request (PROT-06)
  review/            Webhook, fix-or-merge loop, merge lane (PROT-07)
  vcs/               GitHub REST client, and a mock of it
  sandbox/           Provider interface; local and E2B
  events/            Pub/sub with a durable tail
  budget/            Spend ceilings and the kill switch
  secrets/           Config validation and redaction
```

Tests come in three layers — domain in node, components in jsdom, and the
board end to end in a real browser. `docs/testing.md` says what belongs in
each, and what is not covered yet.

`src/lib/domain` has no I/O and no framework imports. Everything that decides
whether something is *allowed* lives there, which is why it is the part with
the most tests.

## Two things worth knowing

**File scope is the concurrency contract.** Tickets declare directory prefixes
they may touch. The Architect Agent's graph is validated server-side for
cycles and for scope overlap between tickets that could run at the same time,
and a Coder Agent's diff is checked against its scope before it may commit. A
prompt asking nicely for isolation is not a boundary.

**Nothing reaches the base branch unattended.** The Reviewer Agent merges into
`formic/integration`; promoting that to the base branch is a human's click.
`MERGE_TARGET=base` turns that off, which is the PRD's original behaviour and
should be a decision someone makes on purpose. Either way the merge lane is
serialized: one merge in flight at a time, each rebased on the result of the
last.

**The local sandbox provider is not isolation.** It runs child processes on the
host with host network and filesystem access. It exists so the system can be
built and tested without an E2B account. Use E2B for anything running
model-authored code you have not read.

## GitHub webhook

PROT-07 reacts to CI. Point a repository webhook at `/api/webhooks/github`,
content type `application/json`, secret matching `GITHUB_WEBHOOK_SECRET`, and
subscribe it to **Check runs**, **Check suites**, **Workflow runs** and **Pull
requests**. Without the secret the endpoint returns 503 and handles nothing —
an unsigned delivery can start an agent, so it is never accepted.

Deliveries are idempotent on `(pull request, head sha, check)`, not on the
delivery id, so a redelivery under a new id is still the same result and still
does nothing. A result about a commit that is no longer the head is dropped.

## Status

All twelve tickets are implemented. The lifecycle runs end to end: a backlog
request becomes a PRD, a PRD becomes a validated ticket DAG, a ticket becomes
a pull request from a sandbox, CI drives a bounded fix-or-merge loop, and a
fully merged Epic gets a showcase.

Two limits worth naming. Agent runs are not durable: a worker that dies
mid-run fails its card with a reason on restart rather than resuming, and the
sandbox is reclaimed by its TTL (`src/lib/agents/recovery.ts`). And the event
bus is single-process, so more than one server instance needs it swapped for
Postgres LISTEN/NOTIFY or Redis.
