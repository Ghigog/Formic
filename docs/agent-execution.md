# Where agent work runs

There are two hosts, and which one an agent gets is decided by what the provider
*is* — not by how the person pays for it. That mismatch is the reason the same
plan feels different in two columns, and the reason these numbers arrive as
confusing errors ("Ran out of time (4 minute budget)", "did not converge in 40
turns"). This is the record of why it is built this way and where it is going.

## The two hosts

| | In Formic's function | In GitHub Actions |
| :-- | :-- | :-- |
| Who runs there | every API provider: Anthropic, OpenAI, Gemini, DeepSeek, ClinePass | CLI agents: Claude Code, Codex, Gemini CLI — and, since `mode: loop`, the API providers too |
| The loop | `src/lib/agents/coding-loop.ts`, in-process | the CLI tool loops itself, or the same `runCodingLoop` as a bundle (`src/lib/runner/loop-entry.ts`) |
| The tools | an E2B sandbox (`src/lib/sandbox/e2b.ts`) holding a checkout | the job's own checkout (`repo.dir` hands it to the entry) |
| Started by | `launch()` → `after()` in the request (`src/lib/agents/pipeline.ts:707`) | `startJobRun` (`src/lib/runner/runner.ts`), from `src/lib/coder/pipeline.ts` |
| Ceiling | the platform's 300 s per invocation (`maxDuration = 300` on every route that starts a run) | the job's `timeout-minutes` (`RUNNER_JOB_MINUTES`, written for each repository by `src/lib/runner/workflow.ts`) |
| Bounded by Formic | `DEFAULT_RUN_BUDGET` (`src/lib/budget/limits.ts:31`): 4 minutes, 3 attempts | the ticket's budget, from its size (`loopBudgetMs`, ten minutes a point), with the job as the backstop |

## Why those numbers are those numbers

- **4 minutes** is deliberately one minute under the 300 s roof, so a run stops
  itself and says "ran out of time" rather than being killed mid-edit and going
  silent. It is AUD-03's second option (`docs/audit.md`); the first was to move
  long runs off the request function, which is where this is heading.
- **40 turns** is a guard, not a plan: a loop that has not converged in forty
  rounds is not about to. Its comment says so, and the failure is blocked rather
  than retried, because a retry of the same approach would fail the same way.
  Forty is the in-process ceiling specifically. A job's loop is handed the turns
  its own budget is worth (`turnCeiling`, `src/lib/budget/limits.ts`: ten a
  minute, which comes out at forty for the four-minute default), so an hour of
  budget is an hour's worth of turns rather than a wall reached a fifth of the
  way in. Two real loop runs died on the fixed forty while their budget had
  twenty-five minutes left.
- **180 minutes** is the job ceiling Formic will write (60 until the ceiling change merges) (GitHub's maximum is 360), and has nothing to do with the
  model or the plan.

## What a person feels

A subscription plan — ClinePass — behaves like Claude Code's usage windows, but
Formic executes it as if it were a metered API, because ClinePass arrived as an
OpenAI-compatible endpoint and that is the single connector for endpoints. In a
repository whose workflow is current it now runs in a job, on the ticket's
budget, with the turn ceiling that budget is worth: the same shape a CLI tool
gets. Where the workflow is older it still inherits the function's roof, which
has nothing to do with the plan.

One consequence of that shape, learned from a real run: a job's log is full of
the project's own output, so a number that looks like an HTTP code is not one.
A loop run that had spent five minutes of a thirty-minute budget and ended on
its turn ceiling was reported as "ClinePass hit its usage limit", with the
line `429 src/lib/db/repository-contract.test.ts` — a line count from the
agent's own `wc -l` — quoted as the evidence, and the agent marked out of usage
for an hour. `LIMIT` and `AUTH` now read a status code only where the log says
it is one ("status code 429", `{"code":429}`), and the loop's own exit line no
longer hides the reason printed before it.

The same mistake came back that evening from the other side, on the ticket
about scope requests: an agent exploring the repository opened
`src/lib/agents/card-actions.test.ts`, whose fixture happens to be
`blockedReason: "Claude Code hit its usage limit.",`, and the card told the
person their plan was spent — while the run had actually died on Cline's own
gateway, `ClinePass error 500: {"error":"empty response content"}`, three turns
in and half a page into its plan. Formic's own tests are full of the phrases a
card is looking for, so a line the agent read, ran or printed is not a provider
speaking: `diagnose` now reads only the lines the job wrote itself, and passes
over a `path:line:` search hit, a line of source, a statement and a patch
(`QUOTED_CODE`). Where a verdict is passed over, the card falls back to the
run's last words, which is the truth even when it is not a kind of failure
Formic knows a remedy for.

## The decision

Work moves to the job host and stays there:

- **Now**: a repository whose workflow is current runs its API-key coders in a
  job, through `mode: loop`: the job fetches the loop as one bundle, runs it in
  its own checkout, and posts what it does back the way a CLI agent does
  (`src/lib/runner/loop-entry.ts`, `/api/runner/bundle`). Such a run works for
  the ticket's budget — ten minutes a story point — instead of four minutes,
  and the key travels as a repository secret, never in a dispatch input.
- **Now**: short work still runs in-process where a repository has not updated
  its workflow, or has none: it has no job setup, so it is snappier, and it must
  fit inside the roof. No card changes behaviour because a feature exists.
- **Next**: the settings that let a person choose the budget (flat, per point,
  by hand, or off) — `docs/run-time-budgets.md` is that spec, and the default
  it describes is what loop runs use today.
- **Still rejected**: running the loop inside the E2B sandbox. One continuous
  process and no job setup, but the provider key would have to live in the very VM
  whose job is executing model-written code, and it adds a third host instead of
  removing one. Revisit only if a repository cannot run workflows.
- **Still rejected**: a queue plus an always-on worker. The most control and the
  most moving parts; nothing needs it while the job host works.

## Errors say what happened

The same principle, and the reason it is written down here too: a provider
failure is reported with its HTTP status and the provider's own words
(`describeProviderError`, `src/lib/agents/limits.ts`), classified by status
first, with the text only as a fallback. Guessing at the words is how
`insufficient_quota` — a spent usage window — was reported as "out of credit",
sending someone to top up an account that was already paid for. An allowance and
a balance are different things and must not share a sentence.
