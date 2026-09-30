# Handoff — the window a per-agent token count is measured over

**Where it stands:** the counting is built and visible (`docs/token-usage.md`,
commit `32c5361`): `agentTokensByPreset(since?)` sums a saved agent's runs and
answers, the agent editor shows the total, and nothing is enforced. The window
is the one open decision.
**Read first:** `docs/token-usage.md`, and `docs/run-time-budgets.md` for the
storage shape the settings work plans (columns on `User`).

**User story:** As the person paying monthly for my agents, I'd like the token
number to say what it is measured over and to line up with when my plan renews,
so that I can tell how much of the month is left.

### Why the obvious answer is wrong here

A calendar month is wrong for the plan this was built for: ClinePass renews on
the purchase date (`$9.99/mo`, `src/lib/llm/providers.ts:146`), so on the 5th
"this month" is measuring the wrong four days. Formic cannot know a plan's
renewal date; only the person can say it.

### What is counted, and what is invisible

- Counted: every run Formic drives (`AgentRun.tokensIn/Out`, from the
  provider's own usage), every answer it makes in-process
  (`CardChatMessage.tokensIn/Out`), and a `mode: loop` job's reported usage.
- Not counted: a true CLI agent on a plan (Claude Code, Codex, Gemini CLI).
  `usageOf` (`src/lib/runner/runner.ts:174`) says it plainly: "a CLI agent on a
  plan reports none, and none is what it gets". So an agent on `kind: "cli"`
  shows nothing, while ClinePass — a flat plan too, but an OpenAI-shaped
  endpoint — shows real tokens. The screen should say which case it is, or a
  missing number looks like a bug.

### The options

| window | reads as | needs | judgment |
| :-- | :-- | :-- | :-- |
| A renewal day the person sets | "since 5 September" | one stored day-of-month | matches the plan; the definition is the person's |
| All-time + a Reset button | "3.2M since 5 September" | one stored timestamp | nothing to guess; a click a month |
| Rolling 30 days | "in the last 30 days" | nothing | simplest to explain, never lines up with a renewal |
| Calendar month | "this month" | nothing | easiest to say, wrong for a mid-month renewal |

**Recommendation:** the renewal day, with Reset as the fallback for anyone who
would rather not name one. Both store one small value on `User` beside the
time-budget settings, and both leave `agentTokensByPreset(since?)` as it is —
the caller computes `since`.

### The follow-on it decides

An enforced allowance depends on this. When it comes, an exhausted allowance
reuses what exists: set `AgentPreset.limitedUntil` (via `setPresetLimit`) to the
next boundary with a note, and the board's existing "Out of usage until…" note
(`agent-select.tsx`) renders it with no new UI. `savePreset` already clears a
limit when a new key arrives, which is the right escape hatch.

### Acceptance criteria

- [ ] Given a saved agent with usage, then its settings say what the number is
      measured over ("3.2M tokens since 5 September"), not just a total.
- [ ] Given a renewal day, then the number restarts on the rollover without
      anyone pressing anything.
- [ ] Given no renewal day and a Reset press, then the count restarts from that
      moment.
- [ ] Given an agent that reports no tokens, then its settings say so, rather
      than showing zero as if it had done nothing.

### File scope

`src/lib/db`, `src/lib/agents`, `src/app/api/agents`, `src/app/api/settings`,
`src/components/settings`, `src/components/board`, `prisma`

### Traps

- `agentTokensByPreset` already takes `since`: do not add a second sum for the
  window.
- Do not compute a boundary in the server's timezone by accident: it is the
  person's calendar, not the server's.
