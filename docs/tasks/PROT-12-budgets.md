# PROT-12 — Run budgets and kill switch

**Status:** proposed (not in source PRD)
**Depends on:** PROT-06
**Size:** S

## Why

Two loops in this system retry on failure with a model in the middle: the coder
agent iterating on failing tests (PROT-06) and the reviewer agent iterating on
CI (PROT-07). Both can run unattended. Neither has a documented ceiling.

The design spec already puts live token usage in the ambient drawer, so the
data is expected to exist — this ticket makes it enforceable rather than
decorative.

## Scope

- Per-run token and wall-clock budget, enforced, with the run parked as blocked
  when exhausted.
- Per-Epic aggregate budget.
- Attempt counters on coder and reviewer loops.
- A visible global stop: halt all runs, dispose all sandboxes.
- Cost surfaced per ticket and per Epic in the UI.

## Acceptance criteria

- An agent stuck on an unfixable test stops at its ceiling and says so.
- The stop control disposes every live sandbox within seconds.
- Token spend per ticket is visible without opening a log.

## Notes

- Task budgets (`output_config.task_budget`) let the model pace itself toward a
  ceiling and finish gracefully rather than being cut off mid-edit. Use them
  alongside a hard enforced cap, not instead of one.
