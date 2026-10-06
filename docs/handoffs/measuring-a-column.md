# Measuring a column, before changing anything about it

Written after a session that cost a person hours, in which a working
configuration was "fixed" twice. Every fact below is checkable, and the first
two are the whole of what went wrong.

## The traps, in the order they cost the most

- **`cline-pass/…` slugs are the plan's; `vendor/model` ids are the metered
  API.** `/models` at api.cline.bot lists the second kind, and nothing in it
  contains the word "cline". Asking for one of those ids bills the **API
  balance**, which a plan holder has never funded: `402 insufficient_credits`
  on the run's first turn. So **a 402 is a model's answer, not a verdict on the
  account.** Replacing the slugs with catalog ids therefore *creates* a 402 on a
  board that was working. `40ba52c` put the slugs there for this reason; run
  `git log -S 'cline-pass/'` before touching them.
- **A durable API key from app.cline.bot works with the plan's slugs.** It is
  the ordinary credential, it does not expire, and it has no session to refresh.
  Do **not** replace it with an account session token: the session the extension
  and CLI mint is retired by the CLI's own next refresh — hourly, and on every
  command — so a copy pasted into an agent goes stale on its own, and the run
  that used it fails later and elsewhere, as a 401.
- **A ticket can spend a whole budget working.** "Write AGENTS.md" reads the
  repository to describe it. Two points bought 128,000 tokens and the run used
  every one of them: a *successful* run with too small a budget, not a broken
  one. Size the work, reading included (`prompts.ts`, `decomposition.ts`).
- **A document describing a problem is not evidence that the problem is live.**
  `docs/cline-audit.md` says of itself, in its second paragraph: "This is a
  proposed epic, not shipped work." Its blocker 5 is real *for someone who
  pastes a session token*; it was not what that board was doing.

## The two habits that would have stopped it

1. **Measure the column before changing it.** One call, with the credential the
   agent actually holds and the model it actually names, and the status it
   answers — before any edit. Five lines of shell, or the button proposed below.
2. **Suspect the last change first.** The 402 arrived in the run immediately
   after the slugs were replaced. Reverting that one commit would have shown it
   in a minute. A symptom that appears next to a change is that change until
   proven otherwise.

## What to build: a "Test this agent" button

One press in the agent editor: a single `chat` call, no tools, one token, and
the raw answer shown as it arrives — the HTTP status and the provider's own
words, the same ones `limits.ts` reads. It turns this whole class of
misunderstanding into a measurement.

- `POST /api/agents/test` takes the preset id — or a provider, model and key for
  one not saved yet — and calls `chat` once with "ok", `maxTokens: 1`, no tools.
- It answers `{ ok, status, message }` and never throws: a refusal *is* the
  finding.
- The editor puts it beside Save, under the key and model fields.
- Tests: a stubbed 200; a stubbed 402 carrying ClinePass's own body; and one
  whose fetch throws, which must read as "could not ask", never as a refusal.

## The rule for whoever commits next

**A check whose exit status guards a commit must not be piped.** `npx tsc --noEmit
| head` exits 0 whatever the compiler said. A broken import reached `main` that
way, and the board's own dev server could not compile the module — the evidence
is still in `~/Library/Logs/Formic.log`, as `Expected ',', got '{'` against
`src/lib/runner/runner.ts`. Check the status, then commit.
