# Where agent work runs

There are two hosts, and which one an agent gets is decided by what the provider
*is* — not by how the person pays for it. That mismatch is the reason the same
plan feels different in two columns, and the reason these numbers arrive as
confusing errors ("Ran out of time (4 minute budget)", "did not converge in 40
turns"). This is the record of why it is built this way and where it is going.

## The two hosts

| | In Formic's function | In GitHub Actions |
| :-- | :-- | :-- |
| Who runs there | every API provider: Anthropic, OpenAI, Gemini, DeepSeek, ClinePass | CLI agents: Claude Code, Codex, Gemini CLI |
| The loop | `src/lib/agents/coding-loop.ts`, in-process | the CLI tool loops itself |
| The tools | an E2B sandbox (`src/lib/sandbox/e2b.ts`) holding a checkout | the job's own checkout |
| Started by | `launch()` → `after()` in the request (`src/lib/agents/pipeline.ts:707`) | `startCliAsk` / the runner dispatch (`src/lib/runner/runner.ts`) |
| Ceiling | the platform's 300 s per invocation (`maxDuration = 300` on every route that starts a run) | the job's `timeout-minutes: 60` (`.github/workflows/formic-agent.yml:55`, written for each repository by `src/lib/runner/workflow.ts:347`) |
| Bounded by Formic | `DEFAULT_RUN_BUDGET` (`src/lib/budget/limits.ts:31`): 4 minutes, 3 attempts | the same budget, but time is not charged between turns on this path |

## Why those numbers are those numbers

- **4 minutes** is deliberately one minute under the 300 s roof, so a run stops
  itself and says "ran out of time" rather than being killed mid-edit and going
  silent. It is AUD-03's second option (`docs/audit.md`); the first was to move
  long runs off the request function, which is where this is heading.
- **40 turns** (`MAX_ITERATIONS`, `coding-loop.ts:41`) is a guard, not a plan: a
  loop that has not converged in forty rounds is not about to. Its comment says
  so, and the failure is blocked rather than retried, because a retry of the same
  approach would fail the same way.
- **60 minutes** is GitHub's, adjustable to 360, and has nothing to do with the
  model or the plan.

## What a person feels

A subscription plan — ClinePass — behaves like Claude Code's usage windows, but
Formic executes it as if it were a metered API, because ClinePass arrived as an
OpenAI-compatible endpoint and that is the single connector for endpoints. So its
runs inherit the function's roof and the loop's turn cap, neither of which has
anything to do with the plan. The same plan used through a CLI tool gets an hour,
because the job has an hour.

## The decision

Work moves to the job host and stays there:

- **Now**: short work stays in-process. It has no job setup, so it is snappier —
  but it must fit inside the roof.
- **Next**: the same loop runs as an Actions job, so an API-model coder can work
  for as long as a CLI agent, against the ticket's own time budget rather than a
  serverless wall. The loop is already portable: `runCodingLoop` takes an injected
  `Workspace`, an API key and a context with `emit`/`interrupts`, returns an
  outcome with usage, and touches no database, repository or event bus — those
  live around it, in `src/lib/coder/pipeline.ts` and `src/lib/agents/pipeline.ts`.
  Its only Next-specific line is `import "server-only"`.
- **Rejected for now**: running the loop inside the E2B sandbox. One continuous
  process and no job setup, but the provider key would have to live in the very VM
  whose job is executing model-written code, and it adds a third host instead of
  removing one. Revisit only if a repository cannot run workflows.
- **Rejected for now**: a queue plus an always-on worker. The most control and the
  most moving parts; nothing needs it while the job host works.

## Errors say what happened

The same principle, and the reason it is written down here too: a provider
failure is reported with its HTTP status and the provider's own words
(`describeProviderError`, `src/lib/agents/limits.ts`), classified by status
first, with the text only as a fallback. Guessing at the words is how
`insufficient_quota` — a spent usage window — was reported as "out of credit",
sending someone to top up an account that was already paid for. An allowance and
a balance are different things and must not share a sentence.
