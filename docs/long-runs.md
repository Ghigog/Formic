# Long runs for an API-model coder

Step 2 of the run-length work: an agent on an API key (ClinePass, DeepSeek,
Anthropic…) should be able to work as long as a CLI agent, instead of being
stopped by a serverless roof. `docs/agent-execution.md` records the two hosts and
why this is where the work goes. This records the problem that has to be solved
first, the two routes, which one is chosen, and why.

## The problem: our loop is TS in our repository, the job runs in theirs

The CLI path works because a *tool* runs in the person's Actions job. Claude Code,
Codex and Gemini CLI are installed there and do their own looping, so nothing of
ours has to be there.

Formic's loop is different. It is TypeScript in this repository —
`runCodingLoop` and the shapes around it. A job in someone else's repository does
not have it, and that is the whole of the problem. There are two ways to solve it:

**Route 1 — ship the loop to the job.** Build the loop into one bundle at deploy
time, leave it where the job can fetch it (the house already signs expiring URLs
for attachments: `runner.ts:1440`), and have the job run it. The loop then lives
in one process for as long as the job runs, and its tools run in the job through
the **local** workspace, which already exists (`src/lib/sandbox/local.ts`).

**Route 2 — drive the loop from the job.** Leave the loop in Formic and have the
job call an endpoint per turn: load the conversation, one model call, run the
tools, append, return. Each request is short, so the roof stops mattering, and
nothing is shipped into the job. Tools keep running in E2B, as they do today.

## Chosen: Route 1

The argument is atomicity, not packaging.

A turn is not a safe unit to persist. A model call returns several tool calls,
some of which change files; if a turn is interrupted or retried, the tool effects
have to be applied exactly once, or the agent edits the same file twice and the
diff grows a duplicate. Route 2 therefore needs idempotency per turn over the
*file system*, not just over a database row — the hardest kind to get right, on
the code path that writes to someone's repository.

Route 1 has no such problem: the loop, its transcript and its tool effects all
live in one process, which either finishes or does not. The costs are mechanical
and visible: a build step, a way to serve the bundle, and a workflow mode that
fetches it. The app already signs expiring URLs, and the job already posts
progress and checkpoints back for the CLI path, so both halves have a precedent
to copy.

Two things to be honest about:

- **Trust.** A local workspace is not isolation — its own comment says so. But the
  job is a disposable, repository-scoped GitHub runner, and the CLI agents already
  run the person's own tooling there with `--dangerously-skip-permissions`. Route
  1 asks for no more trust than the path people already use, and it removes the
  sandbox bill for these runs. A job that must be locked down can still run the
  bundle against E2B instead: the workspace is chosen at the call site, and
  `scopedWorkspace` wraps either provider, so file-scope checks are unaffected.
- **Version skew.** The loop in the job is a build of a particular commit. The
  build is produced from the commit being deployed and recorded with the run, so a
  job cannot be running code nobody can identify.

## The work, in order

1. **An entry point that can run outside Next**: `runCodingLoop` with a local
   workspace, a ticket payload, a provider key, and progress posted back the way
   the CLI runner posts it. `import "server-only"` is the only Next-specific line
   in the loop today; the entry is new code.
2. **A bundle and a way to fetch it**: one file built in CI, served at a signed,
   expiring URL, with the commit it was built from.
3. **A workflow mode**, `mode: loop`, in `src/lib/runner/workflow.ts`: the job
   fetches the bundle, runs it, and reports progress, failures and usage the way
   the CLI modes already do. `timeout-minutes` becomes the real ceiling.
4. **Then the budget**: the ticket's own time budget (minutes per story point)
   becomes the plan, and the job ceiling is the backstop.

## Acceptance

- An API-model coder runs for the ticket's budget (ten minutes per story point by
  default), not four minutes, and the card says which limit stopped it when one
  did.
- No file is ever edited twice by a resumed or retried run, because nothing is
  resumed mid-turn: a job is one continuous loop.
- A run that hits the job ceiling says so and stays retryable.
- Nothing can loop forever: the ticket's budget, the run's attempt ceiling and the
  job's timeout all still apply.
- The bundle's commit is recorded on the run, so what ran is identifiable.

## Where this stands

Steps 1, 2 and 3 are built, and step 4's default is in place.

**Step 1** — `src/lib/runner/loop-entry.ts`, the entry: one JSON payload in,
one JSON report out — with `src/lib/runner/loop-entry.test.ts` proving it runs
the Coder Agent's loop against a checkout and produces a diff with no network
and no database. The payload carries the ticket's budget as `limits`, and a run
that hits one says which limit stopped it.

**Step 2** — the bundle and where to fetch it. `scripts/build-loop-entry.mjs`
builds the entry into one file before `next build` (aliased `server-only` to a
no-op, exactly as `vitest.config.ts` does), records the commit it was built
from in a banner inside the file and in the sidecar, and leaves both in
`src/generated/loop-entry/`. `/api/runner/bundle` serves them to a job at the
signed address `loopBundleUrl` builds — the same HMAC and the same claim as
`reportUrl`: this one job, while its card waits on it — and answers 503 (never
an empty script) where a build produced no bundle. The bundle is
`outputFileTracingIncludes`d into that function's deployment.

**Step 3** — `mode: loop` in `src/lib/runner/workflow.ts`, and the dispatch
behind it. The job fetches the entry, hands it the job's own checkout
(`repo.dir`) with the key injected from the repository's Actions secrets,
appends its progress to the same stream a CLI agent's is read from, and writes
the run's report as the commit: its summary and handoff, a `Formic-Usage:`
trailer the runner counts on the ticket, and `Formic-Already-Done` when the
ticket was already done. `startJobRun` dispatches it, `completeCliRun` collects
it, and `loopRunnerReady` decides: a repository whose workflow is current runs
its API-key coders this way, and one that is not keeps running them in-process
until it is updated — no card changes behaviour because a feature exists.

A loop run can be watched while it works: the loop says what it is doing before
its first model call, not only after its first tool call, and its own lines go
to the job's log as well as to the board — a step that prints nothing cannot be
told apart from one that is stuck.

**Step 4, the default** — the ticket's budget is the plan: `loopBudgetMs` gives
it ten minutes a story point (`MINUTES_PER_POINT`), capped at 175 (55 until the ceiling change merges) so the job's
180-minute (today 60) `timeout-minutes` stays the backstop, and a run that reaches it stops
and says which limit it was. The settings that let a person choose the budget —
flat, per point, by hand, or off — are `docs/run-time-budgets.md`'s own work,
and this default is what it says a missing setting means.

One deploy's chain, end to end: build, serve on a signed URL, fetch with curl,
run with plain `node`.

Two things to know for the rest:

- The loop's own turn ceiling is given to it rather than fixed: `turnCeiling`
  (`src/lib/budget/limits.ts`) turns the ticket's budget into turns, ten a
  minute, so a job's loop is bounded by its budget and the ceiling only ends a
  run that has stopped converging. In-process runs keep the forty that matches
  the four-minute default. A fixed forty was a wall the budget was meant to
  replace: a real job run died on it four minutes into a thirty-minute budget.
- A bundle run by path must compare **real** paths when it decides whether
  node started it, not `argv[1]` to `import.meta.url`: node resolves the
  module it started while argv keeps the path as typed, and on macOS `/tmp` is
  a symlink to `/private/tmp`. A plain comparison finds no match, and the entry
  then does nothing and exits 0, which is the worst way for a job to fail.

## Not now

- Idempotent per-turn state (route 2). Revisit only if turn-by-turn is forced on
  us, such as by a provider whose latency makes long jobs impossible.
- Bundling into an image, or publishing to npm. A signed URL and a single file are
  enough until they are not.
- A queue and an always-on worker. Still more machinery than the problem needs.
