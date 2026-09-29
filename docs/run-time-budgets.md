# Run time budgets

How long an agent may work on a ticket should be the person's decision, not a
constant buried in the app. This file is the spec for that: read it, then break
it into tickets.

## Why

Two numbers bound a run today, neither of them chosen by the person:

- `DEFAULT_RUN_BUDGET.maxDurationMs` — four minutes — in
  `src/lib/budget/limits.ts`, which bounds an agent Formic calls itself.
- `timeout-minutes: 60` on the Actions job that runs a CLI agent
  (`.github/workflows/formic-agent.yml:55`, and `src/lib/runner/workflow.ts:347`
  writes that same 60 into the workflow generated for each repository).

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
  360 minutes per job, so a budget of 10 to 60 minutes is expressible. This is the
  path the budget is really for.
- **An agent on an API key runs inside Formic's own function**, which the platform
  terminates at 300 s (Hobby; 800 s on Pro) — every route that starts a run
  declares `maxDuration = 300`. A budget larger than that window cannot be
  honoured in one invocation, so that run's allowance is `min(the budget, the
  window)` and the card must say which limit stopped it.

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
