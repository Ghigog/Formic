# PROT-01 — Next.js frontend and Kanban UI

**Depends on:** none (soft dependency on PROT-00 for card/column types)
**Size:** M
**Owns stage:** 1 — Prompt

## Goal

A responsive 5-column Kanban board running on mock state, correct enough in
layout and interaction that every later ticket has a surface to render into.

## Scope

- Next.js App Router project, TypeScript, Tailwind.
- Columns: Backlog, To Do, In Progress, In Review, Done.
- Drag and drop with `@hello-pangea/dnd`.
- Card component with the metadata slots the design spec calls for: ticket ID
  (mono), size/complexity badge, model tag, agent badge, status.
- Header bar: project selector, repo sync indicator, "New Backlog Item" CTA,
  Epic completion progress bar.
- Mobile: below 768px the board becomes a sticky column tab bar with a swipe
  view; drag and drop is replaced by an "Advance Card" action.
- Mock fixture data covering at least one Epic with child tickets, one card in
  each column, and one failed card.

## Out of scope

- Persistence (PROT-02), any agent call, the Epic drawer (PROT-03/04), the
  sandbox inspector (PROT-06), the showcase view (PROT-08).

## Acceptance criteria

- Board renders all five columns and survives a drag between any two of them.
- Moving a card emits a single typed `transition` event with `from`, `to`,
  `cardId`. Later tickets subscribe to this; nothing else triggers agent work.
- At 375px width there is no horizontal page scroll and every column is
  reachable.
- No hardcoded hex values in components — colors come from tokens (PROT-09).

## Notes and risks

- `@hello-pangea/dnd` does not support touch drag well enough to be the mobile
  story on its own. The spec already routes mobile to tap-to-advance; keep
  those two paths separate rather than trying to unify them.
- The column transition is the app's only user-facing trigger. Treat it as an
  API boundary from day one: emit an event, do not call agent code from a drag
  handler.
