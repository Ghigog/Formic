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
- Thinking effort is set per role: `medium` on Claude (`requestShape` in
  `models.ts`), `low` on DeepSeek (`reasoning.ts`), and the coding loop
  passes a task budget so the model paces itself.

## Next

Routing by ticket size: a 1-point ticket on a smaller model than an 8-point
one, chosen per preset. The ticket's story points are already there; the
preset would need a second, lighter model.
