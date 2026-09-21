# PROT-03 — Backlog "Product Agent" pipeline

**Depends on:** PROT-02
**Size:** M
**Owns stage:** 2 — PRD Draft

## Goal

A raw one-line feature request dropped into Backlog becomes a structured Epic
PRD.

## Scope

- Endpoint triggered on card creation in Backlog.
- Anthropic API call turning the raw string into a formatted Epic PRD:
  problem, scope, out of scope, technical context, user stories, success
  criteria.
- PRD stored on the Epic, rendered in the left pane of the Epic drawer in
  editorial serif per the design spec.
- Run recorded in `agent_run`: model, tokens, duration, status.
- Regenerate action, and a manually editable PRD — the human must be able to
  overwrite what the agent wrote.

## Out of scope

- Ticket decomposition (PROT-04).

## Acceptance criteria

- Raw string in, PRD out, persisted, visible in the drawer.
- A failed or refused call leaves the card in Backlog with a visible error
  state, never a half-written PRD.
- The PRD is editable and an edit survives a reload.

## Notes and risks

- **The PRD spec names Claude 3.5 Sonnet.** That is several generations stale.
  Default to `claude-opus-5` with adaptive thinking; Sonnet 5 is the
  cost-tuned option for this particular call since PRD drafting is the least
  demanding of the four agents. Pin model IDs in one config module so the
  choice is one edit, not a grep.
- Streaming the PRD into the drawer as it generates is most of the perceived
  quality of this feature. Worth doing here rather than retrofitting.
- Garbage in, garbage out: a two-word backlog item produces a PRD that reads
  fine and decomposes into nonsense. Consider a clarifying-question turn before
  the PRD, or accept it and lean on the human edit path.
