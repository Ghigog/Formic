# PROT-02 — Database and state persistence

**Depends on:** PROT-01
**Size:** M

## Goal

Board state survives a reload. Epics, tickets, column position and ordering are
stored and read back.

## Scope

- Postgres (Supabase or plain) with Prisma.
- Tables per PROT-00: `project`, `epic`, `ticket`, `ticket_dependency`,
  `agent_run`, `event`.
- CRUD endpoints for card create, update, reorder and column move.
- Optimistic UI update on drag with server reconciliation on failure.
- Seed script that loads the PROT-01 fixture data.

## Out of scope

- Multi-user auth, multi-project support, row level security.

## Acceptance criteria

- Drag a card, reload, card is in the new column at the same index.
- Reordering within a column persists.
- A failed write rolls the card back to its previous position with a visible
  error, not a silent revert.
- `agent_run` rows exist and are written even though nothing yet creates them,
  so PROT-03 onward has somewhere to log.

## Notes and risks

- Ordering: use a fractional index (or a `position` float) rather than a dense
  integer array. Dense reindexing turns every drag into an N-row write and will
  race against agent-driven moves as soon as PROT-06 lands.
- Column position is derived state once agents start moving cards. Store the
  ticket's `status` as the source of truth and treat the column as a view of
  it, so an agent transition and a user drag go through the same path.
