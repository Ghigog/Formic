# PROT-10 — Realtime event transport

**Status:** proposed (not in source PRD)
**Depends on:** PROT-02
**Size:** M

## Why

Four of the five columns display live state: agent progress bars, pulsing
borders, streaming terminal output, live file diffs, CI status, the ambient
agent drawer's active-sandbox count and token usage. None of that works on
request/response, and no ticket provides the transport.

Retrofitting realtime after PROT-06 means rewriting how every agent reports
progress.

## Scope

- Server-sent events (or Supabase realtime) channel per project.
- Event types: ticket status change, agent run progress, log line, diff chunk,
  CI status, token usage tick.
- Client subscription hook with reconnect and replay from a cursor, so a
  reconnecting tab does not lose the middle of a run.
- Backpressure on log streams — a noisy `npm install` must not flood the client.

## Acceptance criteria

- Two browser tabs stay in sync as a card advances.
- A tab reconnecting after 30s offline catches up rather than showing a gap.
- The ambient drawer's counts are live, not polled.

## Notes

- SSE is the right default here: one-directional, works through proxies, far
  simpler than websockets. Commands still go over normal HTTP requests.
