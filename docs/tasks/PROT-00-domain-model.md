# PROT-00 — Domain model and shared contracts

**Status:** proposed (not in source PRD)
**Depends on:** none
**Size:** S

## Why

The source dependency chain is almost perfectly linear:
01 → 02 → 03 → 04 → 06 → 07 → 08, with only PROT-05 hanging off the side. One
person can build this; a team cannot parallelise it. The reason is that every
ticket discovers the data shapes the previous one invented.

Defining the types and the trigger contract first turns one chain into three
parallel tracks: UI (01, 09, 10), agents (03, 04), and execution (05, 06).

## Scope

- Shared TypeScript types: `Project`, `Epic`, `Ticket`, `TicketDependency`,
  `FileScope`, `AgentRun`, `Event`, `TicketStatus`.
- The transition contract: what a column move emits, what an agent consumes,
  what it writes back.
- The `AgentRun` lifecycle: queued, running, succeeded, failed, blocked, with
  the fields every agent logs.
- A mock agent implementation satisfying the contract, returning canned
  responses, so 01/02/09/10 can be built and demoed before any real agent call
  exists.

## Acceptance criteria

- The board runs end to end against mock agents, with cards advancing through
  all five columns on fake data.
- Replacing a mock with a real agent is a single module swap.
