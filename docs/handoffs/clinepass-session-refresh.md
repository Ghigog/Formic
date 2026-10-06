# ClinePass: refresh the plan's session, instead of asking for a key

## The problem

Formic asks a ClinePass column for an "API key". Cline's gateway issues durable
keys under `app.cline.bot` > Settings > API Keys, and those bill the *API
balance*. A person on the $9.99 plan has never funded that balance, so a call
with one answers `402 insufficient_credits` on its first turn — which reads as
"you have no credits" to someone whose plan is working everywhere else.

What the plan answers to is the **account session** the Cline extension and CLI
mint for themselves — a WorkOS JWT — together with the `cline-pass/…` slugs
(`providers.ts`; `/models` lists the metered catalog, which is the other thing).
That session expires, so a person who pastes it is pasting again an hour later.
This is `docs/cline-audit.md` blocker 5, and this is the work that closes it.

## What is on the machine (probed 6 October 2026)

- The CLI keeps its session in `~/.cline/data/settings/providers.json`.
- Under `providers["cline-pass"].settings.auth`: `accessToken` (1013 chars),
  `refreshToken` (25), `expiresAt` (ms), `accountId`, `tokenType: "Bearer"`,
  `tokenSource: "manual" | "oauth"`, and `metadata.userInfo.email`.
- Two entries can be present (`cline` and `cline-pass`) for one account; the
  later `expiresAt` is the one to use.
- The refresh is a standard grant: `{ grant_type: "refresh_token",
  refresh_token, client_id }`, against WorkOS —
  `https://api.workos.com/user_management/authenticate`. The CLI's bundle
  (`/opt/homebrew/lib/node_modules/cline`) carries the candidate client ids
  `client_01K3A5415VF6QBQBG3XYCW91G6`, `client_01K3A541FN8TA3EPPHTD2325AR`,
  `client_01K6XQAY7JK6T5HXVSZW2S5VYK`; which one ClinePass signs in with is
  settled by making the grant once against a real refresh token.

## The shape of the fix

1. A ClinePass credential is **either** a durable API key (as today) **or** a
   refresh token, told apart by shape, so nothing that works stops working.
2. `src/lib/llm/cline-session.ts`: hand it a refresh token, get an access token
   — refreshing within a few minutes of `expiresAt`, cached in memory, and
   sealing the rotated refresh token back onto the preset.
3. Only `clinepass` goes through it; every other provider is unchanged.
4. The desktop app offers the session already on the machine — it can read that
   file in local mode — rather than making the person find and paste it.
5. **Say so when it happens**, without obstructing (the requirement as asked):
   - a line on the run log when a refresh happens: *"ClinePass session
     refreshed; valid until 14:32."*
   - the agent in Settings: *"Session refreshed 3 minutes ago, expires 14:32."*
   - a refresh that **fails** is the actionable one: a card-level note naming
     it, and the agent marked as needing a new sign-in. Never a silent 401 in
     the middle of a run.
6. Tests: a stubbed token endpoint (shape-checked, no network), a controlled
   clock for the expiry window, and a failed refresh surfacing the provider's
   own words on the card.

## Not in scope

A hosted board: there is no local CLI session to read there, so a durable API
key with balance is still the answer, and the note in `providers.ts` still
says so.
