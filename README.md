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
| `DATABASE_URL` | Durable state. Without it, the in-memory store. |
| `ANTHROPIC_API_KEY` | Real agents. Without it, mocks. |
| `GITHUB_TOKEN`, `GITHUB_REPO` | Cloning and pushing. |
| `E2B_API_KEY` + `SANDBOX_PROVIDER=e2b` | Isolated sandboxes. Without it, local child processes. |

```bash
npm run db:local     # throwaway local Postgres, prints a DATABASE_URL
npm run db:push      # apply the schema
npm run db:seed      # demo board
npm run dev
```

`GET /api/health` reports which of those layers are live, plus the build id.

## Scripts

| Command | Does |
| :-- | :-- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Unit and integration tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:local` | Start a local Postgres for development |
| `npm run db:push` / `db:seed` | Apply schema, load demo data |
| `npm run serve` | Start the built app and verify the running build id |

## Layout

```
docs/tasks/          Ticket specs, one file per PROT-xx
prisma/              Schema and seed
src/app/             Routes and API handlers
src/components/      board/ and ui/
src/lib/
  domain/            Status, file scopes, DAG, events, contracts. No I/O.
  db/                Repository interface; Prisma and in-memory
  agents/            Ports, mocks, Anthropic implementations, pipelines
  sandbox/           Provider interface; local and E2B
  events/            Pub/sub with a durable tail
  budget/            Spend ceilings and the kill switch
  secrets/           Config validation and redaction
```

`src/lib/domain` has no I/O and no framework imports. Everything that decides
whether something is *allowed* lives there, which is why it is the part with
the most tests.

## Two things worth knowing

**File scope is the concurrency contract.** Tickets declare directory prefixes
they may touch. The Architect Agent's graph is validated server-side for
cycles and for scope overlap between tickets that could run at the same time,
and a Coder Agent's diff is checked against its scope before it may commit. A
prompt asking nicely for isolation is not a boundary.

**The local sandbox provider is not isolation.** It runs child processes on the
host with host network and filesystem access. It exists so the system can be
built and tested without an E2B account. Use E2B for anything running
model-authored code you have not read.

## Status

PROT-00 through PROT-05 and PROT-09 through PROT-12 are implemented. PROT-06
(Coder Agent), PROT-07 (Reviewer Agent) and PROT-08 (Showcase) are specified
in `docs/tasks/` and not yet built; the showcase agent port and its mock exist,
so the wiring is in place.
