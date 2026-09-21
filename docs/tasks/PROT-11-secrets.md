# PROT-11 — Credential and secret handling

**Status:** proposed (not in source PRD)
**Depends on:** PROT-05
**Size:** S

## Why

From PROT-05 onward the system holds a GitHub PAT with write access to a
repository and an Anthropic API key, and injects both into ephemeral containers
that run model-authored code. No ticket says where they live or how they are
scoped.

## Scope

- Secrets held server-side only; never in client bundles, never in the database
  in plaintext.
- Injected into sandboxes at runtime, scrubbed from every log line and stream
  frame before it reaches the UI.
- GitHub credential scoped as narrowly as the flow allows — a fine-grained PAT
  or GitHub App installation token limited to the single configured repository,
  not a classic PAT.
- Documented rotation path.

## Acceptance criteria

- Grepping logs, event streams and the client bundle for the token prefixes
  returns nothing.
- Revoking the credential fails runs cleanly with a clear message rather than
  hanging.

## Notes

- A GitHub App installation token is meaningfully better than a PAT here: it is
  short-lived, repository-scoped, and its actions are attributable to the app
  rather than to a person.
