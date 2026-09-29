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

## Not now

- Idempotent per-turn state (route 2). Revisit only if turn-by-turn is forced on
  us, such as by a provider whose latency makes long jobs impossible.
- Bundling into an image, or publishing to npm. A signed URL and a single file are
  enough until they are not.
- A queue and an always-on worker. Still more machinery than the problem needs.
