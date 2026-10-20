# Token efficiency

How Formic keeps an agent's token bill small, layer by layer along a request.
Each layer saves on a different part of the bill, so they stack.

## 1. Prompt caching

The coding loop and the chat loop lay every request out the same way: system
prompt, then tools, then the conversation. The system prompt carries a cache
breakpoint (`cachedSystem`), and so does the end of the conversation
(`cachedToHere`), so each turn reads everything before it from the cache.
On Claude a cache read is billed at a tenth of fresh input; OpenAI-format
providers cache a stable prefix on their own, and `openai-compat.ts` counts
their cached tokens the same way.

Single-shot calls (PRD drafting, a ticket draft, the showcase) are left
uncached on purpose: a cache write costs a quarter more than plain input, and
nothing reads it back.

A semantic cache, answering near-identical requests without calling a model,
does not fit here: no two tickets ask for the same change to the same code.

## 2. Model choice

Each column's agent is a saved preset with its own model and provider, so a
board can run the Coder on a strong model and the Product Agent on a cheap
one. Flat-plan providers such as ClinePass are billed per month, not per
token (`billingFor` in `src/lib/budget/limits.ts`).

## 3. Context: what stays in the conversation

Three steps, cheapest first:

- **Tidied output** (`tidyOutput` in `src/lib/agents/observations.ts`). A
  command's output loses colour codes and progress bars redrawn with carriage
  returns, and a run of the same line collapses to one line and a count. An
  `npm install` or a test run is mostly this.
- **Truncation** (`truncate` in `coding-loop.ts`). Past 16,000 characters the
  middle of an output is dropped, keeping the head and the tail, where errors
  and summaries are.
- **Observation masking** (`staleObservations`). Once an agent is three turns
  past a large tool result, that result is replaced with a one-line note
  saying what it was and that it can be run again. The agent keeps its own
  reasoning and every call it made; only the bulky outputs go. Research on
  coding agents (JetBrains, "The Complexity Trap", 2025) found this matches
  LLM summarization on solve rate at a fraction of the cost, and Anthropic's
  context editing applies the same idea server-side.

  Masking rewrites the cached prompt from the first masked result onward, so
  it runs in batches: only once at least 48,000 characters (about 12k tokens)
  of stale output have piled up. Between batches the prefix is stable and
  stays cached.
- **A helper for searching** (`explore` in `coding-loop.ts`). A Coder or
  Reviewer Agent with a broad question (where is this defined, what calls
  it) asks a helper instead of reading for itself. The helper runs its own
  short loop, read-only (list, search, read), on Haiku when the agent is on
  Claude and on the agent's own model otherwise, and only its answer comes
  back. The reading never enters the asking agent's conversation, which every
  later turn re-sends. Several questions in one turn run at once, and the
  helper's tokens count against the ticket's budget.
- **Compaction** (`compactionSummary`). If the transcript still grows past
  96k tokens, or a quarter of the run's token budget, it is replaced by the
  opening prompt, the plan and the files changed. Masking makes this rare,
  which matters: compaction drops everything, and the agent re-reads what it
  needs.

## 4. Output

Output tokens cost several times input, so the agents are kept from writing
more than they must:

- PRDs, decompositions and tickets come back as JSON against a schema
  (`output_config.format`), not prose to parse.
- The Coder edits with `str_replace`, a minimal diff, rather than rewriting
  files.
- Thinking effort follows the ticket's story points (`effortForPoints` in
  `src/lib/budget/budget-for.ts`): low for 1–2 points, medium for 3–5, high
  for 8 and up. Lower effort means fewer thinking tokens and, on easy work,
  fewer tool calls. It rides on the run's budget, so an escalated ticket
  thinks harder with its new points, and a coding loop run in GitHub Actions
  gets it too.
  On Claude it is `output_config.effort`; DeepSeek has no medium, so 3–5
  points stay at low. On by default; Settings → Thinking effort turns it
  off, and every run then thinks at the old fixed level (medium on Claude,
  low on DeepSeek). The coding loop also passes a task budget so the model
  paces itself.
