# Audit: Closed Beta Readiness

**Status:** proposed
**Date:** 2026-09-23
**Scope:** DevOps, QA, Tests, Legal, Financial, SecOps, TechOps

## 1. Summary

Formic's core works and the engineering is sound. Lint, typecheck and build
pass; 375 of 375 unit and component tests pass; 18 of 19 end-to-end tests
pass. It is not ready for a closed beta yet. Three things stand in the way:
the spend ceilings do not hold, the kill switch and budgets do not work
across serverless instances, and there is no legal groundwork for letting
other people's code and credentials through the system.

This document records what the audit found and turns it into tickets.
Tickets marked **P0** block the beta. **P1** should land during the beta.
**P2** can follow.

## 2. Goals

- A closed beta group can sign in, connect a repository, and run the full
  loop without the operator or the user losing money they did not agree to
  spend.
- The operator can stop any run, find out when something breaks, and recover
  from a bad deploy.
- Users know what happens to their code, keys and data, and have agreed to it.

## 3. Non-goals

- Horizontal scale beyond a handful of concurrent users.
- Durable, resumable agent runs (the README's named limit stays for now).
- Billing or payments.

## 4. Findings

### DevOps

| | |
| :-- | :-- |
| **Works** | CI runs lint, typecheck, unit tests, a build against real Postgres and a boot check. `/api/health` reports the commit and pings the database. A post-merge smoke test waits for the deploy and checks it. Only `main` deploys. |
| **Doesn't work** | End-to-end tests are not in CI, so the failing one below shipped unnoticed. |
| **Broken** | Nothing found. |
| **Missing** | Versioned migrations (`prisma db push` has no history and no rollback). A staging environment. Database backup and restore plan. Error tracking and alerting. An incident runbook. Actions pinned by SHA. |

### QA

| | |
| :-- | :-- |
| **Works** | Status transitions, file scopes, the DAG, ordering, webhook handling, the runner, auth and isolation are well covered. |
| **Doesn't work** | Nothing beyond the broken test below. |
| **Broken** | `e2e/board.spec.ts` "a card dragged back to Backlog goes back" fails reproducibly: an Epic moved to To Do does not return to Backlog. |
| **Missing** | Tests for the production data layer (`src/lib/db/prisma-repository.ts`, ~900 lines, zero tests). Event stream fold, keyboard drag, Epic drawer, visual regression and accessibility (already listed in `docs/testing.md`). A beta test plan and a way for testers to report bugs. |

### Tests

| | |
| :-- | :-- |
| **Works** | 375/375 unit and component. 18/19 end to end. Fast. |
| **Doesn't work** | All unit tests run on the in-memory store, not the store production uses. |
| **Broken** | The one end-to-end test above. |
| **Missing** | Repository tests against real Postgres. One full idea-to-merged-PR run against a real repository and a real E2B sandbox; so far it has only run on mocks. |

### Legal

| | |
| :-- | :-- |
| **Works** | Nothing in place yet. |
| **Doesn't work** | Not applicable. |
| **Broken** | Not applicable. |
| **Missing** | Terms of service or beta agreement. Privacy policy. A list of the third parties that receive data (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Groq, E2B, Vercel, GitHub). Account and data deletion. A LICENSE decision. |
| **To review** | Agents run with permissions off (`--dangerously-skip-permissions`, `yolo`) in users' repositories, which needs a liability clause. Whether provider terms allow pasting a Claude subscription token or a ChatGPT `auth.json` into a third-party service. DeepSeek processing customer code in China. Vercel Hobby prohibits commercial use. |

### Financial

| | |
| :-- | :-- |
| **Works** | Per-run and per-Epic ceilings exist, with attempt and time limits. |
| **Doesn't work** | Ceilings are kept in process memory, so on Vercel an Epic's budget forgets finished runs and each instance counts only its own. |
| **Broken** | `estimateCostCents` (`src/lib/budget/limits.ts`) prices only four exact Claude model ids. Every other model (OpenAI, Gemini, DeepSeek, OpenRouter, Groq, and dated or newer Claude ids from the live model list) costs $0, so the $2 run and $20 Epic caps never trip for them. |
| **Missing** | A per-user cap on the operator's fallback E2B key. Spend history and a monthly cap per user. Telling users that CLI agents use their own Actions minutes (up to 60 per run). |

### SecOps

| | |
| :-- | :-- |
| **Works** | Webhooks must be signed and are idempotent. Keys are AES-256-GCM at rest and never returned. Per-user isolation is enforced server-side. OAuth state and safe redirects. The server's GitHub token is never lent to a signed-in user. Agent diffs are checked against file scope before push. Nothing reaches the base branch without a human by default. The Actions workflow passes the prompt through env, not interpolation, and gates secrets by prefix. |
| **Doesn't work** | Removing someone from `FORMIC_ALLOWED_USERS` works, but there is no other way to end a session: logout only clears the browser's cookie, and a copied cookie is valid for 30 days. |
| **Broken** | `FORMIC_SECRET` is not required in GitHub mode. Without it, sessions and stored tokens are keyed off the database URL, or the constant `"formic-local-only"` when there is no database, which makes sessions forgeable. `/api/health` does not warn. |
| **Missing** | Rate limiting (`/api/login` accepts unlimited password guesses). Security headers (CSP, HSTS, frame-ancestors). An audit log. `/api/health` is public and describes the deployment's configuration. `npm audit`: 4 high in `mysql2` via Prisma tooling; the app uses Postgres, so exposure is low. |

### TechOps

| | |
| :-- | :-- |
| **Works** | Runs orphaned by a restart fail with a reason. Health degrades gracefully; a malformed optional variable no longer takes the app down. |
| **Doesn't work** | The event bus is single-process; on Vercel the stream falls back to a 2-second database poll. Fine for a few users. "Stop all" only reaches runs in the instance that handles the click. Agent runs are allowed 15 minutes but the Hobby function stops at 300 seconds. |
| **Broken** | Nothing beyond the above. |
| **Missing** | Custom error and not-found pages. Monitoring. The demo board is seeded into the production database and inherited by the first user. A support contact for beta users. |

## 5. Tickets

| Id | Title | Priority | Domain | Depends on |
| :-- | :-- | :-- | :-- | :-- |
| AUD-01 | Price every model, and refuse to run an unpriced one | P0 | Financial | |
| AUD-02 | Keep budgets and the kill switch in the database | P0 | Financial, TechOps | |
| AUD-03 | Fit agent runs inside the function's time limit | P0 | TechOps | |
| AUD-04 | Require FORMIC_SECRET in GitHub mode | P0 | SecOps | |
| AUD-05 | Terms, privacy policy and beta agreement | P0 | Legal | |
| AUD-06 | Delete my account and my data | P0 | Legal | |
| AUD-07 | Fix the Backlog round trip, and run e2e in CI | P0 | QA, DevOps | |
| AUD-08 | Test the Prisma repository against real Postgres | P1 | Tests | |
| AUD-09 | Versioned migrations, backups and a staging environment | P1 | DevOps | |
| AUD-10 | Error tracking and alerting | P1 | TechOps | |
| AUD-11 | Rate limits and security headers | P1 | SecOps | |
| AUD-12 | Revocable sessions | P1 | SecOps | |
| AUD-13 | Cap the operator's fallback E2B key per user | P1 | Financial | |
| AUD-14 | Keep demo data out of production | P1 | TechOps | |
| AUD-15 | A real end-to-end run before beta opens | P1 | QA | AUD-01..04 |
| AUD-16 | Error pages, support contact and bug reporting | P2 | TechOps, QA | |
| AUD-17 | Trim what /api/health tells strangers | P2 | SecOps | |
| AUD-18 | Pin Actions and clear audit findings | P2 | DevOps, SecOps | |

---

### AUD-01: Price every model, and refuse to run an unpriced one

**User story.** As a beta user, I'd like my spend ceiling to hold whatever
model I pick, so that a runaway loop cannot bill me without limit.

**Context.** `estimateCostCents` looks up an exact id in a four-entry table and
returns 0 when it misses. Every non-Anthropic model and any Claude id not in
the table (dated ids, newer models from the live list) runs with no cost
ceiling.

**Description.** Give every selectable model a price, and treat an unknown
price as a reason to stop, not as free.

**Requirements.**
- A price table per provider, matched by id prefix or family, not exact id.
- A model with no known price either uses a stated conservative default or
  cannot be saved on a template; the editor says which.
- Unit tests cover each provider and a dated Claude id.

**Acceptance criteria.**
```gherkin
Scenario: A non-Anthropic model hits its ceiling
  Given a template on an OpenAI model with a known price
  When a run spends past the run budget
  Then the run stops and the card says the spend ceiling was reached

Scenario: An unknown model is not free
  Given a model id with no known price
  When someone saves a template with it
  Then the editor says how that model will be charged against the budget
```

### AUD-02: Keep budgets and the kill switch in the database

**User story.** As the operator, I'd like "Stop all" and the Epic budget to
work no matter which server instance runs the work, so that they mean what
they say on Vercel.

**Context.** `src/lib/budget/controller.ts` keeps live runs and spend in a
process-global map. On serverless, a stop request usually lands in a different
instance than the run, and an Epic's spend forgets runs that finished.

**Description.** Persist spend per run and per Epic, and make stop a durable
flag that running work checks.

**Requirements.**
- Spend recorded on `AgentRun` and summed per Epic from the database.
- A stop request writes a flag; agents poll it between steps and abort.
- Sandboxes for a stopped project are disposed by id from the database, not
  from process memory.

**Acceptance criteria.**
```gherkin
Scenario: Stop reaches another instance
  Given a run started by one server instance
  When "Stop all" is pressed on another
  Then the run stops within 10 seconds and its sandbox is disposed

Scenario: Epic budget counts finished runs
  Given an Epic whose finished runs spent 90% of its budget
  When a new run pushes it past the ceiling
  Then the new run stops and the Epic says why
```

### AUD-03: Fit agent runs inside the function's time limit

**User story.** As a beta user, I'd like a coder run to finish or fail cleanly,
so that I never see a card stuck because the platform killed it mid-edit.

**Context.** Runs continue through `after()` up to the function's max
duration (300 s on Hobby), while the run budget allows 15 minutes.

**Description.** Either move long runs off the request function (a queue,
GitHub Actions, or E2B-hosted execution) or set the run budget below the
function limit and say so.

**Requirements.**
- Declare `maxDuration` on routes that start runs.
- The run budget's time ceiling is below the function's limit, or runs no
  longer depend on it.
- A run cut off by the platform is reported as such on its card.

**Acceptance criteria.**
```gherkin
Scenario: A long run does not vanish
  Given a coder run that would take longer than the function limit
  When it reaches the limit
  Then the card says it ran out of time and can be retried
```

### AUD-04: Require FORMIC_SECRET in GitHub mode

**User story.** As the operator, I'd like the app to refuse an unsafe
configuration, so that sessions cannot be forged and saved tokens are not keyed
off the database URL.

**Context.** `signingSecret()` in `src/lib/auth/session.ts` and `key()` in
`src/lib/secrets/vault.ts` fall back to the database URL, then to
`"formic-local-only"`.

**Description.** In GitHub mode, a missing or short `FORMIC_SECRET` is fatal.

**Requirements.**
- GitHub mode without a `FORMIC_SECRET` of at least 32 bytes refuses sign-in
  and reports `ok: false` in `/api/health`.
- Local mode keeps the fallback.
- A test covers both modes.

**Acceptance criteria.**
```gherkin
Scenario: No secret, no sign-in
  Given a GitHub App is configured and FORMIC_SECRET is unset
  When someone opens the sign-in page
  Then sign-in is refused with a message for the operator
  And /api/health reports the missing secret
```

### AUD-05: Terms, privacy policy and beta agreement

**User story.** As a beta user, I'd like to know what happens to my code, keys
and data before I connect a repository, so that I can agree to it knowingly.

**Context.** Users' code and prompts go to up to nine third parties. Agents run
with permissions off in the user's repository. Users paste subscription
credentials. None of this is disclosed.

**Description.** Legal review, then publish the documents and require
acceptance at first sign-in.

**Requirements.**
- Terms of service or beta agreement, including a liability clause for agent
  actions in the user's repositories.
- Privacy policy and a list of third parties with what each receives and where.
- Review of provider terms for Claude subscription tokens and ChatGPT sign-ins,
  and of DeepSeek data residency; restrict or label providers accordingly.
- Decision on Vercel plan (Hobby prohibits commercial use).
- LICENSE decision for the repository.
- Acceptance recorded per user with the version accepted.

**Acceptance criteria.**
```gherkin
Scenario: First sign-in asks for agreement
  Given a new user signs in with GitHub
  When they have not accepted the current terms
  Then they see the terms and privacy policy before the board
  And their acceptance is stored with its version
```

### AUD-06: Delete my account and my data

**User story.** As a beta user, I'd like to delete my account, so that my
tokens, keys and boards do not stay on the platform after I leave.

**Context.** Cascades exist in the schema, but no endpoint or UI triggers them.

**Description.** A delete action in Settings that removes the user and
everything they own, and revokes their GitHub token.

**Requirements.**
- `DELETE /api/account` with confirmation.
- Removes user, projects, presets, keys, events and messages; revokes the
  GitHub user token.
- Documents what remains on GitHub (issues, branches, pull requests, repo
  secrets) and how to remove it.

**Acceptance criteria.**
```gherkin
Scenario: Account deletion
  Given a signed-in user with a board and a saved agent
  When they delete their account and confirm
  Then they are signed out
  And none of their rows remain in the database
```

### AUD-07: Fix the Backlog round trip, and run e2e in CI

**User story.** As a user, I'd like to pull an Epic back to Backlog after moving
it to To Do, so that I can change my mind before the Architect's work lands.

**Context.** `e2e/board.spec.ts` "a card dragged back to Backlog goes back"
fails every run. CI does not run end-to-end tests, so this was not caught.

**Description.** Find why the move back is refused or undone, fix it, and add
the end-to-end suite to CI.

**Requirements.**
- The test passes on desktop and mobile projects.
- `ci.yml` runs `npm run test:e2e` against the pre-installed Chromium.

**Acceptance criteria.**
```gherkin
Scenario: Epic returns to Backlog
  Given an Epic in Backlog
  When a user drags it to To Do and then back to Backlog
  Then it stays in Backlog

Scenario: CI catches browser regressions
  Given a pull request that breaks a drag
  When CI runs
  Then the end-to-end job fails
```

### AUD-08: Test the Prisma repository against real Postgres

**User story.** As a maintainer, I'd like the store production uses to be
tested, so that a query bug is caught in CI, not by beta users.

**Context.** `src/lib/db/prisma-repository.ts` has no tests. Every unit test
uses the in-memory store.

**Description.** Run the repository contract tests against both stores.

**Requirements.**
- One shared contract suite, run against memory and Postgres.
- CI provides the Postgres service already used by the build step.

**Acceptance criteria.**
```gherkin
Scenario: Both stores agree
  Given the repository contract suite
  When it runs against memory and against Postgres
  Then both pass the same assertions
```

### AUD-09: Versioned migrations, backups and a staging environment

**User story.** As the operator, I'd like to roll a schema change forward and
back, and restore data, so that a bad deploy does not cost beta users their
boards.

**Context.** Builds run `prisma db push`. There is no migration history, no
staging database, and no backup plan.

**Requirements.**
- `prisma migrate` with committed migrations; `migrate deploy` in production.
- A staging environment with its own database.
- Point-in-time backups on the production database and a tested restore.
- A short runbook: deploy, roll back, restore.

**Acceptance criteria.**
```gherkin
Scenario: Restore
  Given a production backup from yesterday
  When the runbook's restore steps are followed on staging
  Then the board matches yesterday's state
```

### AUD-10: Error tracking and alerting

**User story.** As the operator, I'd like to hear about a failure before a
beta user reports it, so that I can fix it first.

**Requirements.**
- Server and client error tracking with secrets redacted (reuse
  `src/lib/secrets/redact.ts`).
- Alerts on smoke-test failure, health `ok: false`, and error spikes.

**Acceptance criteria.**
```gherkin
Scenario: A server error is seen
  Given error tracking is configured
  When a route throws
  Then the error appears with the route and commit, and no secrets
```

### AUD-11: Rate limits and security headers

**User story.** As the operator, I'd like the public surface hardened, so that
guessing and framing attacks are not free.

**Requirements.**
- Rate limits on `/api/login`, sign-in, and routes that start agent runs.
- CSP, HSTS, `frame-ancestors 'none'`, `X-Content-Type-Options`,
  `Referrer-Policy` via `next.config.ts` headers.

**Acceptance criteria.**
```gherkin
Scenario: Password guessing is slowed
  Given local mode with a password
  When one address posts ten wrong passwords in a minute
  Then further attempts are refused for a while

Scenario: Headers present
  When any page is fetched
  Then the response carries CSP, HSTS and frame-ancestors
```

### AUD-12: Revocable sessions

**User story.** As a beta user, I'd like signing out to end my session
everywhere, so that a copied cookie stops working.

**Context.** Sessions are stateless signed cookies valid for 30 days.

**Requirements.**
- A per-user session version (or session table) checked on each request.
- Logout and "sign out everywhere" bump it.

**Acceptance criteria.**
```gherkin
Scenario: Old cookie stops working
  Given a user copies their session cookie
  When they sign out
  Then requests with the copied cookie get 401
```

### AUD-13: Cap the operator's fallback E2B key per user

**User story.** As the operator, I'd like a limit on how much of my E2B key
each user can use, so that one user cannot run up my bill.

**Requirements.**
- Per-user sandbox minutes or concurrent sandbox cap when the fallback key is
  used.
- The user sees when they are on the operator's key and how much is left.

**Acceptance criteria.**
```gherkin
Scenario: Fallback key cap
  Given a user without their own E2B key
  When they reach the cap
  Then new runs stop and ask them to add their own key
```

### AUD-14: Keep demo data out of production

**User story.** As a beta user, I'd like my first board to be mine, so that I
am not handed a demo Epic with fake pull requests.

**Context.** `seedIfEmpty()` seeds any empty database; `adoptUnowned` gives it
to the first person who signs in.

**Requirements.**
- No seeding when `VERCEL_ENV=production` or in GitHub mode, unless an explicit
  flag is set.

**Acceptance criteria.**
```gherkin
Scenario: Clean production
  Given an empty production database in GitHub mode
  When the first user signs in
  Then they see the repository picker, not the demo board
```

### AUD-15: A real end-to-end run before beta opens

**User story.** As the operator, I'd like to have seen one idea become a merged
pull request on real infrastructure, so that the first beta user is not the
first test.

**Requirements.**
- A throwaway repository, real GitHub App, real E2B, a real API key and one
  CLI agent.
- Backlog to showcase, with notes on every stop and failure.
- Findings filed as tickets.

**Acceptance criteria.**
```gherkin
Scenario: Full loop on real infrastructure
  Given the production deployment and a throwaway repository
  When a backlog request is taken through every column
  Then a pull request is merged into formic/integration and the showcase renders
```

### AUD-16: Error pages, support contact and bug reporting

**User story.** As a beta user, I'd like a clear page when something breaks and
a way to report it, so that I am not left guessing.

**Requirements.**
- `error.tsx`, `global-error.tsx` and `not-found.tsx` in the app's style.
- A support contact and a "report a bug" link in the account menu.

**Acceptance criteria.**
```gherkin
Scenario: Unknown page
  When a user opens a path that does not exist
  Then they see a styled not-found page with a way back to the board
```

### AUD-17: Trim what /api/health tells strangers

**User story.** As the operator, I'd like the public health check to say
whether the app is up and little else, so that it does not describe my
configuration to anyone who asks.

**Requirements.**
- Unauthenticated: `ok`, `commit`, `database`.
- Signed in (or with a token): the full report as today.
- The smoke test keeps working.

**Acceptance criteria.**
```gherkin
Scenario: Anonymous health check
  When /api/health is fetched without a session
  Then it returns ok, commit and database only
```

### AUD-18: Pin Actions and clear audit findings

**User story.** As a maintainer, I'd like CI and the agent workflow to run the
code I reviewed, so that a moved tag cannot change what runs with our secrets.

**Requirements.**
- Pin `actions/*` in `.github/workflows/` by commit SHA, with Dependabot to
  bump them.
- Resolve or document the `mysql2` advisories pulled in by Prisma tooling.

**Acceptance criteria.**
```gherkin
Scenario: Pinned actions
  When the workflows are read
  Then every third-party action is referenced by a full commit SHA
```
