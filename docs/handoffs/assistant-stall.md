# Handoff — the assistant stalls the same way a card's chat did

**Where it stands:** unfixed. A card's chat had this exact failure and it is
fixed (commit `88af1fd`); the assistant was left out.
**Read first:** `CHAT_ANSWER_BUDGET_MS` in `src/lib/agents/card-chat.ts`, and
`recovery.ts` — the shape to copy.

**User story:** As the person asking the board's assistant something, I'd like a
long answer to stop and say what it reached, rather than hang forever and lock
the assistant, so one slow question does not cost me the feature.

### What happens today

Ask something that outlives the invocation's window, or that reaches 16 tool
rounds:

- the message shows "Thinking…" forever (`assistant.tsx:302`), the input stays
disabled (`assistant.tsx:101,407`, placeholder "Answering…"), and
`use-assistant.ts` polls at it forever;
- asking again is refused: `POST /api/assistant` returns **409 "The assistant is
still answering the last question."** So the assistant is locked out, and only
clearing the conversation gets it back.

### Why, in three parts

1. **No `maxDuration` on the route.** `src/app/api/assistant/route.ts` sets
   `dynamic` only. Every sibling that starts agent work declares 300
   (`src/app/api/epics/[id]/chat/route.ts:13` and the rest). `launch()` relies
   on `after()`, and its own comment (`src/lib/agents/pipeline.ts:718`) states
   the invariant this breaks: the work is kept alive "up to the function's max
   duration — the `maxDuration` declared on the route that called this", so
   that "a run notices its own budget and stops cleanly, rather than the
   platform cutting it off with no chance to report why".
2. **No clock in the loop.** `MAX_TURNS = 16` (`src/lib/assistant/turn.ts:32`),
   and no `Date.now()` in the file: nothing stops it before the platform does.
3. **Nothing sweeps an orphaned answer.** A killed function writes nothing, so
   the message stays pending. `recoverStaleCardChats` covers card chats only,
   and there is no `orphanedCardChats` equivalent for `AssistantMessage`.

### Requirements

1. **A clock.** `MAX_ANSWER_MS` (four minutes, under the 300s cap with room for
   the call in flight), checked at the top of each turn; on expiry, stop and
   say what it read and reached — `outOfRoundsMessage` is the existing shape,
   and `outOfTimeReply` in `card-chat.ts` is the wording to mirror.
2. **Declare the window.** `export const maxDuration = 300` on the route.
3. **Sweep orphans.** `recoverStaleAssistantAnswers(projectId)`: a pending
   assistant message no job is behind, older than any function could still be
   writing (10 minutes, `CHAT_ORPHAN_AFTER_MS`), becomes `failed` with "The
   assistant stopped before it could answer. Ask it again." Call it from
   `sweepIdleCards` beside `recoverStaleCardChats`, and publish so an open
   drawer updates. Add `orphanedAssistantAnswers` to the repository interface
   and both stores, with the contract suite holding both to it.
4. **Test both:** a clock test with a provider that outlives the budget (mirror
   `card-chat.test.ts`) and a recovery test (mirror `recovery.test.ts`).

### Acceptance criteria

- [ ] Given an answer that outlives its window, then the message is `done` or
      `failed` with what it reached — never `pending`.
- [ ] Given that, when the person asks again, then it is accepted: no 409.
- [ ] Given a pending answer no job is behind and older than the cut-off, when
      the board ticks, then it is failed and re-askable.
- [ ] Given an ordinary answer, then its timing is unchanged.

### File scope

`src/lib/assistant`, `src/lib/agents`, `src/lib/db`, `src/app/api/assistant`,
`src/components/board/assistant.tsx`, `src/lib/hooks/use-assistant.ts`

### Traps

- Without `maxDuration`, "kept alive by `after()`" means the platform's
  default, which is shorter than 300s, not longer.
- The 409 is the symptom, not the bug: do not relax it without the sweep, or two
  answers race on one conversation.