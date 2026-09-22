# Formic Task Index

Working breakdown of the MVP tickets from
`Autonomous Agent Kanban Web App - PRD & MVP Tickets.md`, cross-referenced with
`Formic_ UI_UX Design Philosophy & Specification.md`.

Each ticket has its own file with scope, acceptance criteria, dependencies and
open questions. The source PRD table stays the contract; these files are the
working detail.

## Tickets

| ID | Title | Depends on | Size |
| :-- | :-- | :-- | :-- |
| [PROT-01](PROT-01-kanban-ui.md) | Next.js frontend and Kanban UI | — | M |
| [PROT-02](PROT-02-persistence.md) | Database and state persistence | PROT-01 | M |
| [PROT-03](PROT-03-product-agent.md) | Backlog "Product Agent" pipeline | PROT-02 | M |
| [PROT-04](PROT-04-architect-agent.md) | To Do "Architect Agent" pipeline | PROT-03 | L |
| [PROT-05](PROT-05-sandbox.md) | E2B sandbox environment | — | M |
| [PROT-06](PROT-06-coder-agent.md) | "Coder Agent" execution loop | PROT-04, PROT-05 | XL |
| [PROT-07](PROT-07-reviewer-agent.md) | Webhook and "Reviewer Agent" | PROT-06 | XL |
| [PROT-08](PROT-08-showcase.md) | Epic "Showcase" aggregator | PROT-07 | S |

Sizes are relative, not estimates in days.

## Proposed additions

Gaps found while writing the tickets up. Not in the source PRD; numbered
separately so the original IDs stay stable.

| ID | Title | Why |
| :-- | :-- | :-- |
| [PROT-00](PROT-00-domain-model.md) | Domain model and shared contracts | Unblocks parallel work on 01/03/05 |
| [PROT-09](PROT-09-design-system.md) | Design system foundation | The UI spec has no ticket anywhere |
| [PROT-10](PROT-10-realtime.md) | Realtime event transport | Four of five columns show live state |
| [PROT-11](PROT-11-secrets.md) | Credential and secret handling | PAT + API key exist from PROT-05 onward |
| [PROT-12](PROT-12-budgets.md) | Run budgets and kill switch | Agents that loop on failure spend money |

## Lifecycle stage mapping

The design spec's 8-stage stepper maps onto the tickets as follows. Useful when
wiring stage state into the Epic drawer.

| # | Stage | Owned by |
| :-- | :-- | :-- |
| 1 | Prompt | PROT-01 |
| 2 | PRD Draft | PROT-03 |
| 3 | DAG Breakdown | PROT-04 |
| 4 | Sandbox Mint | PROT-05 |
| 5 | Code Run | PROT-06 |
| 6 | PR Opened | PROT-06 |
| 7 | Rebase & Merge | PROT-07 |
| 8 | Async Showcase | PROT-08 |
