# PROT-05 — E2B sandbox environment

**Depends on:** none
**Size:** M
**Owns stage:** 4 — Sandbox Mint

## Goal

A service that mints an ephemeral sandbox, clones the target repository into
it, and reports status.

## Scope

- E2B SDK integration behind an internal interface (`spawn`, `exec`, `stream`,
  `dispose`) so the provider can be swapped.
- Clone the configured repo using a GitHub PAT injected at runtime.
- Health/status endpoint: provisioning, ready, running, failed, disposed.
- Hard TTL and guaranteed disposal, including on process crash.
- Log stream exposed as a readable stream for the inspector UI.

## Out of scope

- Anything agent-driven (PROT-06).

## Acceptance criteria

- Spawn, clone, run `npm install && npm test`, stream output, dispose — end to
  end, from a script, with no UI.
- Sandbox is disposed within its TTL even if the caller dies.
- The PAT does not appear in any log line or stream frame.

## Notes and risks

- This has no dependency on PROT-01..04. It is the one piece that genuinely
  parallelizes, so start it on day one alongside the frontend.
- The provider interface matters more than the provider. E2B, Modal and a local
  Docker runner should all be implementable behind it; the PRD itself hedges
  between them.
- Cold clone cost dominates per-run latency. A warm base snapshot with the repo
  and `node_modules` pre-installed is the difference between a 20-second and a
  three-minute agent start.
