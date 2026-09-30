# Token usage, per agent

What each agent has used, counted in tokens, and why tokens are the unit
rather than money. Written after the first attempt — a per-answer cost in
cents — turned out to be something nobody here can verify.

## Why tokens, not money

Two things are true at once about a per-token price:

- **The agents Formic runs here are on a flat plan.** ClinePass is $9.99 a
  month for all the models behind it, so a per-token price is not a thing
  that is charged, and a dollar ceiling measures a number nobody is billed.
  Formic already says so: `billingFor` in `src/lib/budget/limits.ts` returns
  `flat` for such a provider, and everything priced from tokens stays zero.
- **The price table is maintained by hand and has never been checked against
  an invoice.** `PRICE_FAMILIES` in the same file is a starting point, and
  `estimateCostCents` is unverified — see the notes on both. There is no way
  to test the metered path from here either: the keys in this repository's own
  boards are flat-plan ones.

A token count has neither problem. Every provider reports tokens — Anthropic
as `input_tokens`/`output_tokens` (with cache reads and writes beside them),
every OpenAI-format endpoint as `prompt_tokens`/`completion_tokens` — so the
number is the provider's own, not a rate we guessed, and it means the same
thing on a $9.99 plan as on a metered key.

Cents therefore stay what they always were: a ceiling for unattended runs, and
only for a provider that charges per token at all. They are never shown to a
person as a bill.

## What is counted, and where it is written

| Work | Where the tokens land | Attribution |
| :-- | :-- | :-- |
| A run (Product, Architect, Coder, Reviewer, showcase, the loop entry). The showcase run only starts when someone clicks "Generate showcase" on a done Epic, never on its own | `AgentRun.tokensIn`/`tokensOut`, written when the run finishes | `AgentRun.presetId`, from `runTargetFor` |
| A chat answer Formic makes itself | `CardChatMessage.tokensIn`/`tokensOut`, written when the answer lands | `CardChatMessage.agentPresetId` |
| A chat answer a CLI agent gives in Actions | nothing: a plan reports no tokens (`usageOf` in `src/lib/runner/runner.ts`) | `agentPresetId` is still written, so the answer is known to be that agent's |

`agentTokensByPreset(since?)` on the repository sums the first two together per
preset, in two grouped queries. It is what "how much has this agent used" means
everywhere in the app.

Attribution is by the **saved agent** (the preset), not by role or column: that
is the thing a person configures, the thing a plan belongs to, and the thing
they can rename or replace. A run started by a preset carries its id from
`runTargetFor` — the same lookup that already decided its model and who bills
for it — so no pipeline had to change to pass it along.

An agent that is not a saved preset (the mock agents, a server API key in local
mode) has no id, and its work is counted under none: there is no agent to
attribute it to.

## Where it is surfaced today

- **The agent editor** (`src/components/board/agent-editor.tsx`): one line
  under the model field, "3.2M tokens used by this agent, over its finished
  runs and its answers", refreshed when the editor opens. Nothing on a new
  agent, since it has run nothing.
- **A card's chat** (`src/components/board/card-chat.tsx`): under an answer
  Formic made, "182.4k tokens". Nothing under a person's own message, or under
  a CLI agent's answer, which reports no tokens.

Both are `compact()`-formatted, the same helper the ambient drawer counts a
run's tokens with, so the numbers read the same way in both places.

## Open questions, for the owner

These are decisions, not work in progress:

1. **Window.** The editor counts everything the board still holds: no reset
   date. A plan that resets monthly wants a window, and `agentTokensByPreset`
   already takes a `since`. What should the window be — since the 1st (which
   timezone?), the last 30 days, or a "Reset" button next to the number?
2. **A limit, and where it comes from.** Today Formic counts and shows, and the
   plan itself is what stops an agent; when an agent runs out, the existing
   "out of usage until…" state (`AgentPreset.limitedUntil`) is what says so.
   Should an agent also carry an allowance of its own (`maxTokens`) that
   Formic enforces by refusing to start work on it — and if so, is it entered
   by hand, or per provider?
3. **Surface.** The editor shows one agent at a time. The column's agent
   picker (`src/components/board/agent-select.tsx`) lists them all, and is
   probably where "which of my agents is using the plan" belongs, next to the
   existing "out of usage until…" note. Not wired up yet.
4. **The board's assistant.** It runs through the same `Speak` loop, so its
   tokens are available, but its messages live in `assistant_message` with no
   counting columns. Left out of this change on purpose.
