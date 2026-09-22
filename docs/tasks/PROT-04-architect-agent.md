# PROT-04 — To Do "Architect Agent" pipeline

**Depends on:** PROT-03
**Size:** L
**Owns stage:** 3 — DAG Breakdown

## Goal

An Epic moved to To Do is decomposed into child tickets with declared file
scopes and dependency edges forming a DAG.

## Scope

- Triggered on Epic transition into To Do.
- Structured output call returning an array of child tickets, each with:
  title, description, acceptance criteria, `file_scope` (glob list),
  `depends_on` (ticket keys).
- Server-side validation: schema valid, graph acyclic, every `depends_on`
  resolves, file scopes do not overlap between tickets that could run
  concurrently.
- Child tickets persisted and rendered as an accordion under the parent Epic.
- Right pane of the Epic drawer shows the DAG with file boundaries per ticket.
- Pheromone dependency trails: hover shows connectors, a parent reaching Done
  pulses the trail and unblocks its children.

## Out of scope

- Execution (PROT-06).

## Acceptance criteria

- Decomposition returns between 2 and 12 child tickets with a valid DAG.
- A cyclic or overlapping-scope response is rejected and retried with the
  validation error fed back, not persisted.
- A ticket whose dependencies are unmet cannot be dragged to In Progress.

## Notes and risks

- **This is the ticket the product actually rests on**, and the PRD prices it
  as a prompt with a JSON schema. Concurrency safety is the headline claim, and
  a prompt cannot enforce it. File scope must be validated here and *enforced*
  at commit time in PROT-06 — a coder agent that writes outside its declared
  scope gets its diff rejected, not merged.
- Use structured outputs (`output_config.format`) rather than prompt-and-parse.
- Overlap detection on globs is genuinely fiddly. Start with directory-prefix
  scopes only (`/components/ui`, `/lib/db`) and expand later; prefix comparison
  is exact, glob intersection is not.
- Shared files (`package.json`, route manifests, lockfiles) will be touched by
  many tickets. Decide now: either a reserved "shared surface" owner ticket, or
  a serialized merge lane for anything touching them.
