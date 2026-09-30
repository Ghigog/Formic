# Handoff — the job's ceiling caps what the per-point rule promises

**Status: done.** `RUNNER_JOB_MINUTES` is 180 (clamp 175, sandbox TTL
`max(20 min, budget + 5)` unchanged), the card names the ceiling and the
ticket's budget, and a repository that declines the refresh pull request keeps
its old 60-minute job. The text below is the original brief, kept for history;
its figures are the old ones.

**Where it stood:** the arithmetic is built; the ceiling is a constant. The
per-point rule is real (`loopBudgetMs`), `timeout-minutes: 60` is written into
each repository's workflow by Formic, and the two disagree from the 8-point step
up.
**Read first:** `docs/run-time-budgets.md` (whose acceptance includes "a
repository on the older workflow keeps working") and
`docs/handoffs/limits-and-tokens.md`.

**User story:** As the person who set ten minutes a story point, I'd like an
8-point ticket to get the 80 minutes the rule promises — or to be told plainly
that the job's ceiling stopped it — so the number I set means something, and a
card never tells me to raise a budget it cannot give me.

### The arithmetic, today

`loopBudgetMs` (`src/lib/runner/runner.ts:334`) is
`min(points × MINUTES_PER_POINT, RUNNER_JOB_MINUTES − JOB_HEADROOM_MINUTES)`,
that is `min(points × 10, 55)`:

- 5 points → **50 minutes**, as promised.
- 8 points → asks for 80, gets **55**.
- 13 points → asks for 130, gets **55**.

What the card says when it stops there (`timeLimitNote`,
`src/lib/runner/loop-entry.ts:399`): "Ran out of time: this run's budget is 55
minutes. The job's own timeout is the backstop; raise the ticket's budget to
give it longer." — which asks the person to raise a setting that cannot deliver
80 while the job is 60.

### Who can enforce what

- **The run's budget** (`min(10 × points, 55)`) is enforced by the loop entry,
  which stops cleanly and says so.
- **The job's timeout** (60; GitHub allows 360) lives in the repository's own
  workflow, so GitHub enforces it by killing the job — and a killed job writes
  no summary, so the card's reason has to be read out of the logs.
- **A CLI agent's budget cannot be enforced mid-run at all**: Formic does not
  drive its loop, and `timeout-minutes` is a static workflow property, so a
  per-ticket job timeout is not expressible — only a number written into the
  file.
- **The platform's window** (300s) bounds the in-function path only.

### The two decisions, then tickets

1. **Raise `RUNNER_JOB_MINUTES`** (120, or 180; GitHub's ceiling is 360) so the
   rule is expressible above 5 points. The upgrade path exists: changing the
   workflow body changes `RUNNER_HASH`, so `RUNNER_VERSION` changes,
   `ensureRunner` finds a stale copy and offers a refresh pull request — and a
   repository that declines keeps working at 60.
2. **Name the ceiling that applied**, with both numbers: "stopped at the job's
   60-minute ceiling; the ticket's budget is 80". Worth doing even if the
   constant rises, since a repository can always be on an older workflow.

### Acceptance criteria

- [ ] Given an 8-point ticket on a current workflow, then its allowance is 80
      minutes (or the ceiling that applied is named, with both numbers).
- [ ] Given a repository on the old workflow, then runs work exactly as today.
- [ ] Given any run stopped by a ceiling, then the card never points at a
      setting the path cannot honour.

### File scope

`src/lib/runner`, `src/lib/budget`, `.github/workflows/formic-agent.yml`,
`src/components/board`, `docs`

### Traps

- `JOB_HEADROOM_MINUTES` (5) exists so the entry stops itself before the job
  dies; do not eat it.
- The sandbox TTL is `max(20 min, budget + 5)`, so a longer budget keeps a
  checkout alive longer: correct, and it changes what a sandbox costs.
- `RUNNER_JOB_MINUTES` is also written into this repository's own
  `formic-agent.yml`; both have to move together, and a longer job holds a
  GitHub runner longer.
