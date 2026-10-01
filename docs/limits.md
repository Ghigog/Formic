# Limits

Every limit that bounds an agent, in one place. Read from the code as it is
today (`src/lib/budget/budget-for.ts`, `src/lib/budget/limits.ts`,
`src/lib/runner/workflow.ts`), not from the PRD. Where a design in
`docs/run-time-budgets.md` differs from the code, the code is what is listed.

**Enforcement classes**

- **Between turns** — the run checks the limit after each turn and stops itself,
  names the limit, and the card stays retryable.
- **Job** — the limit is carried to the Actions job, which enforces it; the run
  is stopped by the job, or the job's own ceiling applies first.
- **Hard rail** — the platform cuts the run off. Nothing is said on the card by
  the run itself, so budgets are clamped under these rails to stop earlier.
- **Gate** — checked before a run starts; a spent limit prevents the start.

**Settable by a person?** "Yes" means a person may change it (per person in
Settings, or per column); "No" means it is a constant or operator environment
setting.

## Limits a person may set

| Limit | Unit | Default | Scope | Enforcement | Settable |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Run time budget | minutes per attempt | 10 per story point (a ticket with no points counts as 1) | per person; a column may override | Between turns (in-process, loop); Job (CLI agent) | Yes: Off, Flat, Per point, Per point by hand (`runTimeBudget*` on `User`) |
| Token budget | tokens per attempt | 64,000 per story point | per person; a column may override | Between turns (in-process); Job (loop, CLI) | Yes: same four modes (`tokenLimit`) |
| Attempt limit | attempts | review 4, decomposition 3, draft 2, CLI answer 2 | per person; a column may override | Between turns | Yes: same four modes (`attemptLimit`) |
| Column override | minutes, tokens, attempts | none (falls back to the person's setting) | one column of one project | as the axis it overrides | Yes (`overrideMinutes`, `overrideTokens`, `overrideAttempts`) |
| Agent token allowance | tokens per window | none | per agent preset | Gate: an agent at its allowance does not start (re-checked after 1 h) | Yes (`tokenAllowance`) |
| Allowance window | days, rolling | 30; 1 to 366 | per agent preset | with the allowance | Yes (`tokenAllowanceWindowDays`) |

Notes:

- Money is never a setting. A run's cents are derived from tokens at
  2,500¢ per million tokens, and only stop a run on a metered provider; a
  flat-rate plan or an unpriced model is bounded by time and attempts.
- Off is an explicit choice, and a missing value means the default.
  An Off time budget is still bounded by the hard rail of the path it runs on.
- A requested value above a path's hard rail is clamped to the rail, and the
  result names which rail did it.

## Hard rails: what bounds a run whatever is set

| Limit | Unit | Value | Scope | Enforcement | Settable |
| :-- | :-- | :-- | :-- | :-- | :-- |
| In-process window (`maxDuration` on the routes that start a run) | seconds | 300 | a run inside Formic's own function | Hard rail (platform; 800 s on Pro) | No |
| In-process run ceiling (`DEFAULT_RUN_BUDGET.maxDurationMs`) | minutes | 4 | a run Formic bounds itself | Between turns | No |
| Turn ceiling (`turnCeiling`) | turns | 10 per budget minute (40 for 4 minutes) | a run's loop | Between turns | No, derived from the time budget |
| Chat answer budget (`CHAT_ANSWER_BUDGET_MS`) | minutes | 4 | a card chat answer | Between turns | No |
| Job timeout (`RUNNER_JOB_MINUTES`, `timeout-minutes` of the workflow) | minutes | 60 | one Actions job, current workflow | Job | No (written into each repository's workflow) |
| Job headroom (`JOB_HEADROOM_MINUTES`) | minutes | 5 | the job's clone, install and report | Job; a loop or CLI budget is clamped to 55 | No |
| Legacy job timeout (`LEGACY_JOB_MINUTES`) | minutes | 180 | a repository whose workflow predates the `timeout` input | Job | No, until its workflow is refreshed |
| Job cap (`JOB_CAP_MINUTES`) | minutes | 360 | GitHub's maximum for any job | Hard rail | No |
| Sandbox TTL (`DEFAULT_TTL_MS`) | minutes | 20 | one sandbox | Hard rail (the sandbox disposes itself) | No |

## Other limits on use

| Limit | Unit | Default | Scope | Enforcement | Settable |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Run starts (`RUN`) | requests per minute | 60 | per client address, per process | Gate (rate limit) | No |
| Board refresh (`REFRESH`) | requests per minute | 300 | per client address, per process | Gate (rate limit) | No |
| Shared sandbox minutes (`E2B_FALLBACK_MINUTES_PER_USER`) | minutes per calendar month (UTC) | 30 | per person on the operator's fallback key; none on their own key | Gate | Operator only (environment) |
| Attachments per request | files | 5 | one request | Gate | No |
| Attachment size | bytes | 10 MiB | one file | Gate | No |

## Epic budget

`DEFAULT_EPIC_BUDGET` (`src/lib/budget/limits.ts`) is 2,000¢, 2 hours and 12
attempts per Epic, checked by `recordSpend`. Its time dimension is never
checked: `recordSpend` passes `elapsedMs: 0`. Not settable.
