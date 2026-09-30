# Handoff — the person's limits: time, tokens and attempts, in Settings

**Where it stands:** nothing here is built except the counting it depends on.
The person's *time* budget is specified in full and unbuilt
(`docs/run-time-budgets.md`); the *token* count per agent is shipped and
visible (`docs/token-usage.md`, commit `32c5361`); the numbers themselves live
as constants in six different files, and three of them disagree about what
stops a run.
**Read first:** `docs/run-time-budgets.md` — it already names the four modes,
the per-user storage, the acceptance criteria, and the "must not promise what a
path cannot deliver" rule. Then `docs/token-usage.md` for what is counted now.
**Depends on:** nothing. Both documents are on `main`.

---

**User story:** As the person running a board, I'd like to decide how long and
how much each agent may work — scaled by the ticket's size, flat, or set per
column — so that a run that is going wrong stops itself and tells me, instead
of burning a plan I cannot see until I notice.

### Context

The audit this brief is built from found the limits scattered and, in three
places, wrong. Every row below is a real constant in the tree today:

| limit | unit | default | scope | stops the work? |
| :-- | :-- | :-- | :-- | :-- |
| `DEFAULT_RUN_BUDGET.maxDurationMs` (`src/lib/budget/limits.ts:33`) | ms | 4 min | an in-function run | yes, between turns |
| `loopBudgetMs(points)` (`src/lib/runner/runner.ts:334`) | ms | `10 × points`, ≤ 175 min | a loop run in Actions | yes, in the entry |
| `RUNNER_JOB_MINUTES` (`src/lib/runner/workflow.ts:38`) | min | 180, written into each repo's workflow (60 on an older copy) | a CLI agent in Actions | yes, by GitHub |
| route `maxDuration` (e.g. `src/app/api/tickets/route.ts:10`) | s | 300 | the whole invocation | yes, by the platform |
| `DEFAULT_TTL_MS` (`src/lib/sandbox/types.ts:85`) | ms | 20 min; `max(20, budget + 5)` for a loop | the checkout | yes, by the sandbox |
| `DEFAULT_EPIC_BUDGET.maxDurationMs` (`limits.ts:39`) | ms | 2 h | the Epic | **no — never checked** |
| `turnCeiling(ms)` (`limits.ts:107`) | turns | 10 a minute (→ 40) | the coding loop | yes |
| a card's chat (`src/lib/agents/card-chat.ts:38,51`) | turns + ms | 12 + 4 min | one answer | yes |
| the assistant (`src/lib/assistant/turn.ts:32`) | turns | 16, **no clock** | one answer | only by the platform's kill |
| `taskBudgetTokens` (`limits.ts:117`) | tokens | 64k, from 160¢ (0.8 × the 200¢ ceiling) at a fixed $25/M | advice to the model | the model paces itself |
| attempts | tries | 3 a run, 12 an Epic, 4 reviews, 3 architect, 2 draft, 2 CLI ask | various | yes |
| `maxCents` | cents | 200 a run, 2000 an Epic | metered providers only | yes, and unverifiable |
| `AgentPreset.limitedUntil` | a plan | — | one saved agent | yes: the provider's own fact |

Three things the audit found that are not settings at all:

- **The assistant has the stall we just fixed on card chats.** `POST
  /api/assistant` (`src/app/api/assistant/route.ts:63`) launches an answer, is
  the only route of its class with **no `maxDuration`**, and the loop it starts
  allows 16 turns with no wall-clock ceiling (`grep Date.now` in `turn.ts`
  finds nothing). Nothing sweeps an orphaned *assistant* message:
  `recoverStaleCardChats` (`src/lib/agents/recovery.ts`) covers card chats only.
  A slow answer is killed by the platform and its pending message hangs for
  good.
- **The Epic's time ceiling is decorative.** `recordSpend`
  (`src/lib/budget/controller.ts:128`) checks an Epic against
  `{ cents, elapsedMs: 0, attempts: 0 }`, so its 2 hours and 12 attempts never
  trip.
- **A money constant controls review iterations.**
  `MAX_REVIEWS = DEFAULT_RUN_BUDGET.maxAttempts + 1`
  (`src/lib/review/pipeline.ts:51`): change the cents ceiling and the number of
  times a pull request may be reviewed changes with it.

And two shapes that decide the design:

- **Story points exist on tickets, not Epics.** `Ticket.storyPoints`
  (`prisma/schema.prisma:234`) is set by the Architect Agent. The Backlog and
  To Do agents (Product writing a PRD, Architect breaking down) work on an Epic
  and have no points, so "N × points" cannot express their budget: those two
  columns need a flat or per-column limit, which is why the per-column
  override has to win.
- **"Tokens" is two different knobs.** A **per-run ceiling** bounds one attempt
  and can be enforced between turns in-process (the tally is already per turn);
  for a CLI agent in Actions it can only be **reported** afterwards, from the
  usage trailer its summary carries (`usageOf`, `src/lib/runner/runner.ts:174`)
  — a plan reports no tokens at all. A **per-agent allowance** bounds a plan
  over time and can only be enforced by refusing to start more work, which is
  what `AgentPreset.limitedUntil` already does when a plan runs out. Both are
  wanted; they are not the same setting.

### Where the work stands

| Piece | State |
| :-- | :-- |
| `docs/run-time-budgets.md`: the four modes, storage, acceptance | written, unbuilt |
| `loopBudgetMs` feeding a loop run's `limits.maxDurationMs` | built |
| a run that reaches a time limit stops and names it | built |
| the four modes, per-user storage, the Settings screen | **not built** |
| the ticket's "12 of 20 minutes used" line | **not built** |
| per-column overrides | **not built** |
| tokens per saved agent, counted and shown | built (`32c5361`) |
| a per-run token ceiling, a per-agent token allowance | **not built** |
| every path reading one budget resolver | **not built**: `beginRun` always gets `DEFAULT_RUN_BUDGET` (`src/lib/agents/pipeline.ts:54`) |
| the assistant's clock, its route's `maxDuration`, its orphan sweep | **not built** |
| the Epic's time and attempt dimensions | **never checked** |

### Requirements

1. **Fix what the audit found first, as its own tickets.** The assistant's
   answer needs a wall-clock ceiling under the platform's window (the shape
   `CHAT_ANSWER_BUDGET_MS` already uses for a card's chat), its route declared
   at the same `maxDuration` as its siblings, and an orphan sweep for a pending
   assistant message that no job is behind — mirroring `recoverStaleCardChats`.
   The Epic's `elapsedMs` and `attempts` are either checked properly or the
   constants are deleted; do not leave a ceiling that cannot fire.
2. **One resolver, and every path reads it.** `budgetFor(project, column,
   ticket)` (name it what it is) returns `{ minutes, tokens, attempts }` for
   the work about to start, and feeds: `beginRun`/`startRun` for an in-function
   run, `loopPayload.limits` for a loop run, and the job's `timeout-minutes`
   for a CLI agent. Today three unrelated mechanisms answer that question, and
   `startRun` never passes a budget at all.
3. **Time, per the existing spec.** The four modes (Off, Flat, `minutes ×
   points`, per point by hand), stored per user, edited in Settings, with the
   default of 10 minutes a point when nothing is set. Off is an explicit
   choice, not an absence, and the screen still says which hard rail remains.
4. **Tokens, on the same shape.** A per-run token ceiling, enforced between
   turns in-process and reported (never enforced) for a CLI agent; a per-agent
   allowance that reuses the existing out-of-usage state so a spent agent stops
   being started and the board already has somewhere to say so. Counted from
   what is already recorded (`agentTokensByPreset`, `AgentRun.tokensIn/Out`,
   `CardChatMessage.tokensIn/Out`) — no new counting.
5. **Attempts, as the third axis**, and the couplings cut: `MAX_REVIEWS`,
   `MAX_DECOMPOSITION_ATTEMPTS`, `DRAFT_ATTEMPTS` and `CLI_ANSWER_ATTEMPTS`
   are four spellings of one idea and should resolve from the same place.
6. **Precedence, in this order:** a per-column override → `minutes × points`
   for a ticket → the flat limit → Off. The shapes above are why the
   per-column override must win.
7. **Money stops being a knob.** The cents ceiling is derived (`tokens × a
   conservative rate`) or left internal; it is never shown to a person and
   never settable. `PRICE_FAMILIES`/`estimateCostCents` stay what they are —
   unverified estimates for bounding unattended burn, and said to be so — and
   `taskBudgetTokens` stops deriving a token instruction to the model from a
   cents guess.
8. **Say which kind of limit each one is**, in the screen and in the card's
   message. Three classes: enforced between turns (in-process), enforced by
   the job (a CLI agent: minutes only; tokens are reported), and hard rails
   (the platform's 300 s, GitHub's 360-minute job cap, the sandbox TTL) that
   any value must be clamped under.
9. **An audit document to work from** (`docs/limits.md`), holding the table
   above with unit, default, scope, enforcement class and settable-or-not per
   row, so the next limit added anywhere has one place to be argued about.

### Acceptance criteria

- [ ] Given a ticket of 8 points with the default mode, when its run starts,
      then its allowance is 80 minutes in-process, and for a loop run the same
      80 is clamped to the job's 175-minute clamp (180-minute job) only above 17
      points, with the card saying whether the job's ceiling or the ticket's
      budget stopped it.
- [ ] Given a column whose agent has its own limit, when a ticket lands there,
      then the column's limit is used, not the per-point one.
- [ ] Given a run that reaches its time or token ceiling, when it stops, then
      the card names the limit, says how to change it, and stays retryable.
- [ ] Given a CLI agent's run, when it finishes, then its tokens are reported
      on the card and no token ceiling was promised to have stopped it.
- [ ] Given a spent per-agent allowance, when new work is offered to that
      agent, then it is not started, and the board says why — the same state a
      spent plan already produces.
- [ ] Given Off, when a run is dispatched anyway, then the screen says what
      still bounds it, and the run still stops at that rail.
- [ ] Given an assistant question, when the answer outlives the invocation,
      then the message does not stay pending and the chat takes questions
      again.
- [ ] Given the Settings screen, when a person reads it, then no limit is
      offered that its path cannot enforce.

### File scope

`src/lib/budget`, `src/lib/runner`, `src/lib/agents`, `src/lib/assistant`,
`src/lib/board`, `src/lib/db`, `src/app/api/settings`,
`src/components/settings`, `src/components/board`, `prisma`, `docs`

### Traps worth not rediscovering

- `startRun` (`src/lib/agents/pipeline.ts:54`) passes no budget, so every
  in-function run silently gets `DEFAULT_RUN_BUDGET`. That is where a resolver
  has to arrive first, not only in the settings screen.
- `RUNNER_JOB_MINUTES` is written into each repository's own workflow when
  Formic installs it (`workflow.ts:393`), so raising it in Formic does not
  raise it for a repository that already has the file. A budget must clamp
  under what the repository actually carries, or a run dies at the job's limit
  with nothing said.
- The loop entry's payload clamps at `RUNNER_JOB_MINUTES -
  JOB_HEADROOM_MINUTES` (175); the sandbox TTL is `max(20 min, budget + 5)` (unchanged): 85 min for an
  80-minute run, 180 for a 175-minute one. The clamp is conservative — do not
  widen it to fit a budget.
- `taskBudgetTokens` tells the *model* to budget 64k tokens, derived from 160¢
  at a fixed $25/M. It is an instruction the model acts on, so it must move to
  tokens before it can be believed.
- A ticket's used time is not stored: sum its runs' `startedAt`/`finishedAt`
  from `agent_run` rather than adding a counter that can drift.
- `MAX_REVIEWS` is derived from `DEFAULT_RUN_BUDGET.maxAttempts`; moving that
  constant moves review iterations. Which number the reviews should follow is a
  decision, not a rename.
- **The job ceiling was raised to fit the default rule** (done; see
  `docs/handoffs/job-timeout-ceiling.md`). `RUNNER_JOB_MINUTES` is 180, so ten
  minutes a point is honoured up to 17 points: an 8-point ticket gets its 80, a
  13-point one its 130, and anything above 175 is clamped, with the card naming
  the ceiling and the ticket's budget. A repository on an older workflow keeps
  its 60-minute job until it accepts the refresh pull request; declining it keeps
  the old behaviour.
- The assistant and a card's chat are the same kind of loop with different
  budgets (16 turns with no clock, against 12 turns and 4 minutes). Whatever
  the modes become, those two should not disagree again.

### Where these requirements come from

The owner's four answers, given after reading this audit: time and tokens
together if that is tractable, and **time first if it has to split**; the
precedence in requirement 6; Off kept, with the remaining rail named; and the
knobs being time, tokens and attempts, with money never shown. Everything under
"Requirements" 1-2, 7-9 and the trap list is mine from the audit — treat them
as decisions rather than settled scope, and the exact window for a per-agent
token allowance (a calendar month, resetting on the 1st, against a rolling 30
days) as open.
