# PROT-08 — Epic "Showcase" aggregator

**Depends on:** PROT-07
**Size:** S
**Owns stage:** 8 — Async Showcase

## Goal

When every child ticket of an Epic is merged, produce a readable summary of
what shipped.

## Scope

- Triggered when the last child ticket reaches Done.
- Aggregate merged PR diffs and run a summarising call.
- Output: markdown changelog, step-by-step feature walkthrough, unified list of
  changed files.
- Rendered in the showcase modal, editorial serif, with the "View Showcase" CTA
  on the Done column's Epic grouping.

## Out of scope

- Preview URLs, embedded iframes, side-by-side visual diffs, "Approve & Deploy"
  — all four appear in the design spec but the MVP scope explicitly reduces
  this to an aggregated markdown summary. Deployment previews have no ticket
  anywhere; that gap is real but belongs after the MVP.

## Acceptance criteria

- An Epic with all children merged produces a showcase document.
- Re-running is idempotent and does not duplicate the document.
- An Epic with a blocked child does not generate a showcase.

## Notes and risks

- Large Epics will exceed a comfortable context with raw diffs. Summarise per
  PR at merge time in PROT-07 and aggregate the summaries here — cheaper, and
  it means the showcase is mostly written by the time it is requested.
- The "Approve & Deploy" button in the design spec implies a deployment target
  that nothing in the PRD provisions. Either cut it from the mockups or add a
  ticket; leaving it in the design as an orphan will confuse the designer.
