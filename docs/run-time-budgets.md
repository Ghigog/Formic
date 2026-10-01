# Run time budgets

How long an agent may work on a ticket should be the person's decision, not a
constant buried in the app. This file is the spec for that: read it, then break
it into tickets.

## Why

Two numbers bound a run today, neither of them chosen by the person:

- `DEFAULT_RUN_BUDGET.maxDurationMs` — four minutes — in
  `src/lib/budget/limits.ts`, which bounds an agent Formic calls itself.
- `timeout-minutes` on the Actions job that runs a CLI agent
  (`.github/workflows/formic-agent.yml:59`, and `src/lib/runner/workflow.ts:393`
  writes `RUNNER_JOB_MINUTES` into the workflow generated for each repository).
  The target is 180; the code still says 60 until the ceiling change merges, and
  the yml moves with it.

What the tickets already know is their size: `Ticket.storyPoints`
(`prisma/schema.prisma:234`), set by the Architect Agent when it breaks an Epic
down. A budget that scales with the size of the work is therefore already
expressible; nothing needs to be invented to measure it.

## The settings, per person, in Settings

| Mode | Meaning |
| :-- | :-- |
| Off | No time budget at all. The run is bounded only by what the platform allows, and the screen says so. |
| Flat | One number of minutes for every ticket, whatever its size. |
| Per point | `minutes × story points` for every ticket. Default: **10 minutes per point**. |
| Per point, by hand | Per point, with individual values for particular sizes: 1 → 5, 2 → 15, 3 → 20, 5 → 40, 8 → 60. |

Storage: columns on `User` (`prisma/schema.prisma:62`) with a committed migration
in `prisma/migrations/`, saved through `src/app/api/settings/route.ts` and edited
in `src/components/settings/settings-form.tsx` beside the existing key fields. A
missing value means the default, ten minutes per point; **Off is an explicit
choice, not the absence of one**, so an upgrade never silently removes a limit.

## Where a run runs, and what a budget can do there

The two paths have different ceilings, and the settings screen must not promise
what a path cannot deliver:

- **A CLI agent (Claude Code, Codex, Gemini CLI) runs as an Actions job** in the
  repository. The job's `timeout-minutes` is its ceiling, and GitHub allows up to
  360 minutes per job, so a budget of 10 to 175 minutes is expressible. This is the
  path the budget is really for.
- **An agent on an API key runs in the same kind of job**, through `mode: loop`
  (`docs/long-runs.md`): Formic's own loop is fetched as a bundle, runs in the
  job's checkout, and stops on the budget in its payload. Its allowance is
  `min(the budget, the job's 180 minutes less 5 of headroom)`, that is 175 —
  `loopBudgetMs` — and the job is the backstop. The sandbox it runs in lives
  `max(20 min, budget + 5)`: 85 minutes for an 80-minute run, 180 for a
  175-minute one. A longer job also holds a GitHub runner longer. This is what a repository whose workflow is current
  gets today; the default ten minutes a point is already the plan.
- **An agent on an API key runs inside Formic's own function** where the
  repository's workflow is not current, or has never been installed. The platform
  terminates that invocation at 300 s (Hobby; 800 s on Pro) — every route that
  starts a run declares `maxDuration = 300` — so that run's allowance is
  `min(the budget, the window)` and the card must say which limit stopped it.

## Where this stands

The default this file describes is built except the ceiling: a loop run is given ten minutes a
story point, capped under the job's ceiling (`loopBudgetMs`,
`MINUTES_PER_POINT` in `src/lib/budget/limits.ts`), and a run that reaches it
stops and names the limit. Once the ceiling change merges (today the job is 60
minutes, the clamp 55, and the card says "Ran out of time: this run's budget is
N minutes"), a budget above the clamp says the job's 180-minute
ceiling applied and gives both numbers ("stopped at the job's 180-minute
ceiling; the ticket's budget is 200"), while a run that used its own budget says
that one. A repository whose workflow is older keeps its old 60-minute job until
it accepts the refresh pull request Formic offers; declining it changes nothing
for that repository. The four modes, per-user storage, column overrides and the
`budgetFor` rule that resolves them (`src/lib/budget/budget-for.ts`) are in the
code; the settings screen and the "12 of 20 minutes used" line on a ticket have
not been checked against this page. Every limit, with its unit, default, scope,
enforcement class and whether a person may set it, is listed in
[limits.md](limits.md), which is the page to trust where the two differ.

## Acceptance

- Settings offers the four modes, the choice persists per user, and each mode
  explains itself in one line.
- A ticket shows its budget and what it has used: "12 of 20 minutes used".
- A dispatched Actions job is given the ticket's remaining budget as its time
  ceiling, for repositories whose workflow Formic has updated. A repository on the
  older workflow keeps working at its old ceiling until it is updated — no run may
  break because a setting exists.
- A run that reaches the budget stops cleanly, names the limit, and says how to
  change it. The card stays retryable.
- **Off** means no time-based stop, and the settings screen still states what
  bounds the run: the platform's window in-process, the job ceiling in Actions.
- A ticket whose budget is spent does not start another attempt until the person
  raises the budget, moves the card back, or changes the mode.

## Not in scope

Money. Formic does not guess a price for a model: `billingFor`
(`src/lib/budget/limits.ts`) decides whether a run's dollars are real, charges
nothing for what it cannot price, and says which case applies. Reading a
provider's own pricing and limits is separate work — see CL-5 in
`docs/cline-audit.md`.

## Open questions for the Product Agent

- Does the budget cover one attempt or every attempt a ticket makes? Written above
  as one attempt, because that is what a job ceiling can enforce; a ticket-wide
  total is the natural follow-up and may be the better default.
- The Epic budget's time dimension is never checked: `recordSpend`
  (`src/lib/budget/controller.ts`) checks the Epic's cents and passes
  `elapsedMs: 0`. Worth folding in while this work is in the area.
