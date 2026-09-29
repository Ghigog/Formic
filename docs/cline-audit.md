# Cline Audit

What it takes to make Formic work with DeepSeek, audited against DeepSeek's
live API documentation on 28 September 2026.

This is a proposed epic, not shipped work. PR #166 ("Add ClinePass as an agent
provider") is the branch this was audited on.

## Verdict

DeepSeek is **already wired up**. `src/lib/llm/providers.ts:99` has the entry,
`kind: "openai"`, and Formic's OpenAI-format client covers it. Pasting a
DeepSeek key into the agent editor is a working configuration for every column
that does not use tools:

| Column | Path | Works today? |
| :-- | :-- | :-- |
| Backlog (Product) | `openai-agents.ts:91` — JSON, no tools | Yes |
| To Do (Architect) | `openai-agents.ts:91` — JSON, no tools | Yes |
| Done (Showcase) | `openai-agents.ts:330` — plain text, no tools | Yes |
| In Progress (Coder) | `coding-loop.ts:392` — tools | **No: 400 on turn 2** |
| In Review (Reviewer) | `coding-loop.ts:392` — tools | **No: 400 on turn 2** |
| Card chat | `chat-loop.ts:78`, tools at `:95` | **No: 400 on turn 2** |
| Board assistant | `chat-loop.ts:78`, tools at `:95` | **No: 400 on turn 2** |

So the coding half of the board fails on the first tool call, and the run parks
itself at the spend ceiling before it gets there. Three separate causes, below.

ClinePass — the other way in, and the one Cline's $9.99 plan pays for — was
worse off still: on `e150a63` (the PR #166 merge) no ClinePass column ran at
all, planner or coder, first call, because the gateway wraps the answer it
returns for a request that is not streamed. That is blocker 4, and PR #167
(`8c87f9c`, live on 28 September 2026) closes it — checked against
`api.cline.bot` itself and not only against a scripted body. What still stands in
front of a ClinePass column is the credential people paste into it: blocker 5.

And one blocker is not about ClinePass at all. The assistant answers a question
by reading the repository, and it cannot read the middle of a file longer than
16,000 characters — no offset, no line range, no search. Point it at a long
document and it reads the same two ends until its turns are gone, then says `I
read a lot and did not reach an answer.` That is blocker 6, and it is the one
that fails on the board's own audit document.

## Blocker 1 — the tool loop drops `reasoning_content`, which DeepSeek requires back

DeepSeek's thinking mode is **enabled by default at effort `high`**
([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)). In
thinking mode the CoT comes back in `reasoning_content`, beside `content`.

DeepSeek's rule for whether you must send it back is conditional on `tools`:

> If the request carries the `tools` parameter: the `reasoning_content` of all
> previous turns should be passed back to the API and will be concatenated into
> the context.

Formic's tool paths do not comply. `ChatMessage`
(`src/lib/llm/openai-compat.ts:12`) has `content`, `tool_calls` and
`tool_call_id`, and nothing for reasoning. Both tool loops push the assistant
message back stripped:

- `openAiConversation` — `coding-loop.ts:392`, push at `:412`
- `openAiSpeak` — `chat-loop.ts:78`, push at `:96`

DeepSeek's own tool-calling sample shows the shape it expects: the response's
`message` object carries `content`, `reasoning_content` and `tool_calls`
together, and the docs recommend appending that object to the history as-is
rather than rebuilding it field by field. Formic does the latter, which is what
loses the reasoning.

The failure is a 400 on the *second* turn — the first request succeeds, the
tool result goes back, and the next request is rejected:

```
{"error":{"type":"invalid_request_error","message":"reasoning_content must be
passed back when the API responds with reasoning_content. ..."}}
```

Confirmed in the wild at
[NousResearch/hermes-agent#17212](https://github.com/NousResearch/hermes-agent/issues/17212),
which lists `v4-pro`, `v4-flash`, `v3` and `v3.1` as affected.

The JSON planners are safe: their requests carry no `tools`, and the docs say
`reasoning_content` is ignored and not concatenated when `tools` is absent.
That is why the board looks half-working on DeepSeek.

The ClinePass gateway does not enforce this rule. A two-turn tool loop through
the shipped `chat()` against `api.cline.bot` — a tool call on turn one, its
result fed back on turn two, the assistant turn rebuilt with `content: ""` and
no reasoning, exactly as this blocker describes — finished on turn two with
`finish_reason: "stop"` and an answer. So Blocker 1 is `api.deepseek.com`'s rule,
and honouring it is still right for DeepSeek as a provider; it is not what stands
in front of a ClinePass column, and a ClinePass coder run should survive its
first tool call without it.

The Claude path already does the right thing, incidentally — it keeps
`message.content` intact (`coding-loop.ts:335`), which carries the thinking
blocks, and surfaces them as `thoughts` for the card.

## Blocker 2 — DeepSeek's current model ids are unpriced, so runs park at $2

`PRICE_FAMILIES` (`src/lib/budget/limits.ts:141`) knows two DeepSeek ids:
`deepseek-reasoner` and `deepseek-chat`. Neither is served any more. The live
catalogue is `deepseek-flash` and `deepseek-v4-pro`.

An id matching no family gets `CONSERVATIVE_DEFAULT_PRICE` (`limits.ts:156`),
which is the priciest family in the table — `claude-fable-5-1` at **$10.00 in /
$50.00 out per million**. DeepSeek Flash peak is **$0.30 in / $1.20 out** per
million. That is a 33x overcharge on input and 42x on output.

`DEFAULT_RUN_BUDGET.maxCents` is 200 and `recordSpend` stops the run when spend
reaches it (`src/lib/budget/controller.ts:106`), so the ceiling buys 200,000
input tokens at the conservative $10/M — less once output is charged at $50/M —
and a Coder run parks itself after a file or two, reporting "Run budget: Spend
ceiling reached ($2.00)." The real cost of that run is cents.

Pricing the right family moves the ceiling from 200k input tokens to 6.6M, a
33x gain. It does not turn the number into a bill, though: DeepSeek caches
prefixes automatically and charges **$0.006/M** for a Flash cache hit against
**$0.30/M** for a miss (50x), and a tool loop that resends its whole history
hits the cache on most of its input. `ModelPrice` has no cache dimension and
`estimateCostCents` (`limits.ts:203`) takes only in and out, so every cached
token is charged at the miss rate. See CL-7.

`limits.test.ts:77` asserts `deepseek-chat` is priced. It is — and it is also
the one DeepSeek id that no longer exists, which is how this went unnoticed.

`docs/audit.md:80` describes this bug wrongly: it claims unpriced models cost
$0, when the ceiling charges them at the priciest rate in the table. Anyone
reading the audit would conclude the ceilings never trip, when in fact they trip
almost immediately.

**Fixed on this branch.** `PRICE_FAMILIES` carries the live DeepSeek ids at peak
rates — Flash `30 / 120`, V4-Pro `132 / 396` cents per million — and every id
shape CL-1 lists lands on one of them. The deeper change is that the ceiling no
longer prices what it cannot price. A model is `metered`, `flat` or `unknown`,
and only a metered one can be stopped on money:

- **flat** — a subscription, declared on the provider (`providers.ts`,
  `flatRate: true` for ClinePass). Tokens cost nothing extra, so a dollar ceiling
  would measure a number nobody is billed.
- **unknown** — nobody has priced the id. It is charged nothing rather than the
  priciest guess, because stopping unattended work on a rate that does not exist
  is exactly what this blocker was.

Time and attempt limits still stop every run, and the agent editor says which
case a model is in. The trade is deliberate and worth stating: an unpriced
*metered* model now has no dollar guard, and CL-5 — read the price from the
metadata a provider already publishes — is the real answer to that.

## Blocker 3 — `max_tokens` is never sent on the OpenAI path

The Claude paths set an output ceiling: 64,000 (`coding-loop.ts:318`), 8,000
(`chat-loop.ts:59`), 16,000 (`sentinels/agent.ts:207`). The OpenAI path sets
none — `chat()` (`openai-compat.ts:121`) sends `model`, `messages`, `stream`,
`tools` and `response_format` only.

DeepSeek accepts up to **393,216** output tokens and documents that JSON output
"may occasionally return empty content" and that you should "set the
`max_tokens` parameter reasonably to prevent the JSON string from being
truncated midway". Its own `GET /models` returns `max_output_tokens` and
`context_window` per model — and Formic already calls that endpoint in the
agent editor (`src/app/api/providers/models/route.ts:51`), then throws the
metadata away, keeping only `id` (`openai-compat.ts:175`).

## Blocker 4 — ClinePass wraps the answer, so no ClinePass column runs

`api.cline.bot` answers a request that is not streamed with the completion under
`data`, beside a `success` flag, and no top-level `choices`:

```json
{ "data": { "choices": [ { "index": 0, "finish_reason": "stop",
                           "message": { "role": "assistant", "content": "…" } } ],
            "usage": { "prompt_tokens": 14, "completion_tokens": 8 } },
  "success": true }
```

`chat()` looks for `choices[0].message`, finds none, and throws
`ClinePass returned no answer.` (`openai-compat.ts:154`). Its streaming path is
compliant — `choices[0].delta` — and `stream` defaults to `true`; only the
non-streamed one is wrapped. Two upstream issues carry the curl captures:
[cline/cline#12647](https://github.com/cline/cline/issues/12647), where LiteLLM
fails the same way ("provider returned a response with no 'choices'"), and
[cline/cline#13348](https://github.com/cline/cline/issues/13348), which
reproduces it on a **tool-bearing** non-streamed request — Formic's exact shape
— with `message.content: null` and `finish_reason: "tool_calls"`.

The regression is commit `5792664` ("Ask providers for one JSON body, and pin
ClinePass routing"), which added `stream: false` (`openai-compat.ts:126`) to
escape ClinePass's Server-Sent Events default. Before it a ClinePass answer died
at `res.json()`; after it, at the envelope. Either way nothing on ClinePass ran,
which is why the board looked half-working rather than broken: the model picker
reads `GET /api/v1/models`, and that route answers 200 with 459 models —
`deepseek/deepseek-v4.1-flash` among them — for any key at all, including a
bogus one.

Nothing else produces this message, which is how to tell it apart: DeepSeek's
`reasoning_content` 400 prints the provider's own text, a spend ceiling names an
amount, a CLI agent says "finished without an answer", and auth or quota
failures arrive non-200 with the provider's words. `ClinePass returned no
answer.` is this blocker's signature.

## Blocker 5 — the ClinePass credential is a token that dies hourly

Formic asks for an "API key" at `app.cline.bot` (`providers.ts:139`), and that is
the right ask: Cline's API issues keys under **Settings > API Keys**, calls them
"the recommended authentication method for programmatic access", lets you revoke
them, and documents no expiry. The other credential Cline hands out is a
different thing that looks identical in a paste buffer. Signing in to the
extension or the CLI mints an *account auth token* — a WorkOS JWT that Cline's
own client refreshes for itself. On the machine this was found on, the CLI's copy
sits in `~/.cline/data/settings/providers.json` with `iat` and `exp` exactly **60
minutes** apart; the ClinePass entry there was 110 minutes expired at probe time.

Paste one of those into Formic and a ClinePass column runs — until the hour is
up. Then every call answers 401:

```json
{ "error": "Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account." }
```

which `describeProviderError` (`limits.ts:266`) words as `ClinePass rejected the
API key. Edit the agent and paste a valid one.` Nothing in Formic refreshes a
provider key; the only refresh machinery in the repo is GitHub's
(`src/lib/auth/github.ts:89`). Two things make this hard to see: `GET
/api/v1/models` keeps answering 200 with that dead token — and with a bogus one —
so the agent editor loads its model list and the key still looks accepted; and
the failure lands an hour after the key was pasted, not while anyone is looking
at the settings. It is not a bug in `chat()`, and no unwrap touches it.

The ids are the other half of "which key". Cline's ClinePass page lists the slugs
the plan serves — `cline-pass/deepseek-v4.1-flash`, `cline-pass/glm-5.3`,
`cline-pass/kimi-k3`, `cline-pass/qwen3.7-max` and others — and says to send "the
full ClinePass model slug in the model field". Formic's picker offers the
gateway's own list instead (460 ids when probed — 459 an hour earlier, same live
endpoint — with `deepseek/deepseek-v4.1-flash` among them), and that id answers
200 as well, so a column can run on a model the picker names while Cline's
documentation says to address the plan by its own slug. Nothing in Formic says
which to pick.

## Blocker 6 — a long file cannot be read, so an ask about one loops to death

The assistant reads with two tools (`turn.ts:39`), and every `read_file` goes
through `truncate` (`coding-loop.ts:58`) on a budget of 16,000 characters: the
first 8,000, the last 8,000, and the middle replaced by `... [N characters
omitted] ...`. That is a fair way to let a model skim a file. It is a dead end
for a model asked to act on what the middle says, because `read_file` takes a
`path` and nothing else — no offset, no line range, no search. The middle of a
long file is not merely missed; it is unreachable, and reading the file again
returns the same two ends.

`docs/cline-audit.md` is 34,419 characters, which makes the epic's own document
a test case rather than a hypothetical:

| Section | First character | Inside one read? |
| :-- | --: | :-- |
| `## Verdict` | 263 | yes |
| `## Blocker 1` | 1,804 | yes |
| `## Blocker 4` | 7,198 | yes |
| `## Blocker 5` | 9,235 | **no** |
| `## The epic` | 11,525 | **no** |
| `## Tickets` | 13,545 | **no** |
| `### CL-1` | 13,648 | **no** |
| `### CL-9` | 23,857 | **no** |
| `## Evidence` | 27,115 | yes |

Ask the assistant to "add the epic in docs/cline-audit.md" and it cannot see the
epic, nor one ticket in it. It reads the file again — the same head, the same
tail — until the sixteen-turn budget (`turn.ts:32`) is spent, and the person
gets `I read a lot and did not reach an answer. Try a narrower question.` The
wording is true and useless: it names neither the file nor the reason.

Reproduced against ClinePass with `deepseek/deepseek-v4.1-flash`, the real tool
schemas, the real 16-turn budget and the real `truncate`, reading this
repository's own checkout: sixteen rounds, every one ending in tool calls and
none in prose, and the run reported `converged=false invalidArgs=0
turnsWithDsml=0`. The arguments were all well-formed and no `<｜DSML｜>` text
appeared anywhere — so this is not blocker 4, and not the credential. Between
the two runs of the probe, 42 tool calls, and 18 reads came back cut short at
16,038 characters. The model knew what it needed and reached for it in the only
syntaxes it had; five calls tried a range or an alias, and each was answered
`does not exist on main`:

| What the model asked for | What it meant |
| :-- | :-- |
| `docs/cline-audit.md:1200-5000` | lines 1200-5000 |
| `docs/cline-audit.md?range=4000-12000` | characters 4,000-12,000 |
| `docs/cline-audit.md#L60` | line 60 onward |
| `docs/../docs/cline-audit.md`, `docs/legal/../cline-audit.md` | the same file, aliased |

The rest of the hunt was spelling: `./docs/cline-audit.md`, `docs//cline-audit.md`,
`docs/./cline-audit.md`, the path with its case changed (`docs/CLINE-AUDIT.MD`,
`DOCS/CLINE-AUDIT.MD`), the bare `cline-audit.md`, a directory (`docs/legal`) and
a title (`Cline audit`) — fourteen spellings of a file that one `git` call
returns. The tool cannot express what is needed, so the model spends its whole
budget hunting for a spelling of it.

`list_files` compounds this: with no prefix it returns up to 400 paths
(`MAX_FILES_LISTED`, `turn.ts:33`), which was 11,601 characters for this
repository, spent out of the same budget on a list the model did not ask for.

## The epic

Raw request, for the Backlog:

> Set Formic up to run the whole board on DeepSeek, and audit the ClinePass
> path while we are in there. DeepSeek is already a provider, but its coding
> columns break: DeepSeek's thinking mode is on by default and returns
> `reasoning_content`, and any request that carries tools must send all
> previous turns' reasoning back or the API answers 400 on the second turn.
> Formic's tool loops strip it, so the Coder, Reviewer, card chat and board
> assistant all fail on the first tool call. Separately, the live DeepSeek model
> ids (`deepseek-flash`, `deepseek-v4-pro`) match no row in the price table, so
> they fall through to the conservative default at $10/$50 per million tokens —
> 33x the real Flash rate — and every run parks itself at the $2 spend ceiling
> after 200,000 input tokens. And the OpenAI-format client never sends
> `max_tokens`,
> which DeepSeek needs set to keep long answers and JSON from truncating.
> The ClinePass route, on the same plan, is worse: its gateway wraps the answer
> to a request that is not streamed, so no ClinePass column runs at all.
> Fix the reasoning round-trip in the shared client, price the models people
> actually run, and send a real output ceiling per role. DeepSeek's docs are
> the contract: thinking mode, tool calls, JSON output, and models and pricing.

In scope:

- The reasoning round-trip in the OpenAI-format tool loops.
- Correct DeepSeek list prices, and the vendor-prefixed ids ClinePass routes.
- The envelope ClinePass answers with, so its columns run at all.
- An explicit output ceiling and thinking-effort per role.
- DeepSeek's own `suggestedModels`, so the editor is not blank before a key.
- Correcting `docs/audit.md`.

Out of scope:

- Any change to how Claude models are called.
- Image attachments on the OpenAI path. `chat-loop.ts` is text-only and
  DeepSeek Flash takes images, but that is a wider gap (Gemini too).
- A per-user cap, spend history or a monthly ceiling. Tracked separately.

## Tickets

Scopes are `fileScope` prefixes, the way the Architect declares them. Sizes are
relative.

### CL-1 — Price the models people actually run

`src/lib/budget` — M — independent

Replace the two dead DeepSeek rows (`limits.ts:141` — `deepseek-reasoner` and
`deepseek-chat`, neither of which is served) with the live families at **peak**
rates, cents per million: Flash `30 / 120`, V4-Pro `132 / 396`. Off-peak is half
and peak is only 01:00-04:00 and 06:00-10:00 UTC on weekdays, so peak is the
conservative end of the range — the right one for a ceiling.

Four id shapes have to land on a family. `matchFamily` (`limits.ts:164`) strips
a `vendor/` prefix, then takes the *longest* matching prefix, so:

| Requested id | Should price as |
| :-- | :-- |
| `deepseek-flash` | Flash |
| `deepseek-v4-pro` | V4-Pro |
| `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` — legacy names, still accepted and billed at the Flash price | Flash |
| `deepseek/deepseek-v4.1-flash` — ClinePass | Flash |

`deepseek-v4.1-flash` matches neither `deepseek-flash` nor `deepseek-v4-pro` by
prefix, so it needs either a wider match or the ClinePass ids listed by name. A
dated suffix (`deepseek-flash-0813`) already lands by prefix, which is how the
Claude families work today.

Two stale comments repeat the same wrong belief, and they are why nobody
looked: `docs/audit.md:80`, which says an unpriced model costs $0, and the
header of the very table being edited, `limits.ts:117`, which says an unmatched
id falls through "to free". Both are backwards. Fix them here.

Also record the policy for flat-rate plans:
ClinePass bills $9.99/month, so its marginal cost is zero. Recommending list
prices anyway, because the ceiling's job is to bound unattended token burn, and
a zero price silently disables the only guard there is — but it is a policy
call, not a bug fix. `pricingNote` (`limits.ts:193`) is where the user is told.

The flat-rate policy this ticket left open is now decided, by the person paying
for it: a subscription's marginal cost is zero, so a run on one is **not charged
against the spend ceiling**, and is bounded by time and attempts instead. A
guessed price is not a ceiling either: an id nobody has priced is charged
nothing rather than the priciest family in the table. `pricingNote` says which
case a model is in. This supersedes the "recommend list prices anyway"
suggestion above, which would have kept parking runs on money nobody is billed.

**Landed.** Blocker 2 records what shipped: the live ids and their rates, the
`metered` / `flat` / `unknown` distinction, `flatRate` declared on the ClinePass
provider, the provider threaded through `startRun` so a run's ceiling knows what
bills it, and tests pinning the four id shapes, both unmetered cases, and the
metered ceiling.

Acceptance: a Coder run on `deepseek-flash` reaches its own `maxAttempts` rather
than parking at $2 — and a ClinePass run, whose ids are not priced at all by
form, reaches its time or attempt limit the same way.

### CL-2 — Let the client carry reasoning and an output ceiling

`src/lib/llm` — M — independent

The shared client, and the only ticket that touches it. Add:

- `reasoning_content` to `ChatMessage`, alongside `content` and `tool_calls`.
- A `maxTokens` request field, sent as `max_tokens`.
- Optional `thinking: { type: "enabled" | "disabled" }` and
  `reasoningEffort: "low" | "high" | "max"` request fields.

Send `reasoning_content` back **only when the provider returned one** — an
assistant message that echoes a field the provider never sent is how you break
Groq and Gemini, which do not have this problem.

`thinking` belongs at the top level of the JSON body. DeepSeek's docs mention
wrapping it in `extra_body` only because Python SDK users must escape the typed
parameter; `chat()` builds its body as plain JSON (`openai-compat.ts:121`), so
nothing needs wrapping here.

Acceptance: a scripted two-turn tool call via ClinePass records the second
request body, and the assistant message in it carries `reasoning_content` and
`max_tokens`. A provider that returns none sends neither.

### CL-3 — Round-trip reasoning in the tool loops

`src/lib/agents` — M — depends on CL-2

Both `openAiConversation` (`coding-loop.ts:392`) and `openAiSpeak`
(`chat-loop.ts:78`) keep the whole assistant message rather than rebuilding it
from `content` and `tool_calls`. Where the provider returned reasoning, surface
it as `thoughts` with `kind: "thinking"`, the way the Claude path does at
`coding-loop.ts:337`, so a card shows what the agent was thinking instead of
silently paying for it.

This is the ticket that actually unblocks the coding columns.

Acceptance: a two-turn tool call against a scripted DeepSeek-shaped provider
completes, with the reasoning echoed on turn 2. A live Coder run against
`deepseek-flash` gets past its first tool call.

### CL-4 — Ask each role for the effort it needs

`src/lib/agents` — S — depends on CL-2, CL-3

DeepSeek defaults to effort `high` with thinking on, for every turn of every
run, and once `tools` is in play the CoT is concatenated into the context — so
it is billed again as input on each subsequent turn. The Claude path sets
`effort: "medium"` deliberately (`coding-loop.ts:306`). Pick DeepSeek's
equivalent per role, and make it visible in the agent editor rather than
implicit. `low` for the Coder and Reviewer is the analogue; the coercer here is
that a long loop re-bills its own reasoning.

Note that `reasoning_effort` accepts only `low`, `high` and `max` — `none` is
not a value, and turning thinking off is `thinking: { type: "disabled" }`. Read
the accepted levels from `effort.supported_levels` (CL-5) rather than assuming
all three exist.

There is no `medium` either: DeepSeek maps `minimal` and `low` to `low`, and
`medium`, `high` and `xhigh` all to `high`. So the Coder's honest choices are
`low` or `high`, and `low` is the one that stops the loop re-billing a long
chain of thought on every subsequent turn.

Acceptance: the request body carries an explicit `reasoning_effort` and
`thinking` for each role, and no role inherits the server default of `high` by
accident.

### CL-5 — Read the model metadata the provider already gives us

`src/lib/llm`, `src/app/api/providers` — S — depends on CL-2

`listOpenAiModels` (`openai-compat.ts:167`) keeps `data[].id` and discards the
rest. DeepSeek's `/models` returns `context_window` (1048576),
`max_output_tokens` (393216), `input_modalities`, and
`effort.supported_levels` plus `effort.default_level` (`["low","high","max"]`,
default `high`) — which is exactly what CL-2 and CL-4 need to size a request.
Return the metadata and read the effort levels from it, so nothing is
hardcoded: a model that does not support `max` should not be asked for it.

Acceptance: the editor route passes metadata through; a model with a small
`max_output_tokens` is not asked for more than it accepts, and the effort sent
is always one of the levels the model advertised.

### CL-5b — No action: DeepSeek's system-prompt handling already matches ours

`/models` declares `api_capabilities.anthropic_messages.system_prompt_update` as
`leading-only` for V4-Pro and `in-history` for Flash. Formic sends the system
prompt once, first (`cachedSystem`, `anthropic.ts:89`), so it satisfies both
modes without change. Recorded here so nobody "fixes" it later.

### CL-6 — Fill in the DeepSeek provider entry

`src/lib/llm/providers.ts` — XS — independent

`suggestedModels` is empty, so the model picker is blank until a live key is
entered, and `note: "Low-cost models."` says nothing the label did not.
Suggest `["deepseek-flash", "deepseek-v4-pro"]` and describe the offering the
way the ClinePass and Gemini notes already do.

Verify `baseUrl: "https://api.deepseek.com/v1"` against a live key. The route
exists — it answers 401 unauthenticated, not 404 — but DeepSeek's current docs
publish the bare host `https://api.deepseek.com` as the base URL.

### CL-7 — Price cache hits, or stop calling the ceiling a bill

`src/lib/budget`, `src/lib/llm` — M — depends on CL-1, CL-2

DeepSeek caches input prefixes automatically, with no parameter or marker, and
reports the split as `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` in
`usage` (OpenAI reports the same thing as `prompt_tokens_details.cached_tokens`).
A tool loop resends its entire history every turn, so the overlap with the
previous request is a cache hit — at $0.006/M for Flash against $0.30/M for a
miss.

`ModelPrice` is `{ in, out }` and `estimateCostCents` (`limits.ts:203`) takes
two token counts, so every cached token is charged at the miss rate and the
ceiling trips about 50x before real money runs out. `chat()` reads
`usage.prompt_tokens` — from whichever envelope carried the completion — and
drops the cache fields (`openai-compat.ts:161`).

Two ways out; the epic should pick one deliberately:

- Add `cachedIn` to `ModelPrice`, return `cachedTokens` from `chat()`, and take
  it in `estimateCostCents`. The ceiling then tracks money.
- Leave the arithmetic alone and fix the wording. `pricingNote` says
  `Billed as ${provider} ${family} for the spend ceiling`, which promises a
  bill it is not computing. Say on the tin that the number bounds token volume.

Acceptance: the run-spend readout and `pricingNote` either reflect the
cache-hit split or state plainly that they bound tokens rather than money.

### CL-8 — Read the envelope ClinePass actually sends, and decide what it speaks

`src/lib/llm` — S — independent

The unwrap is already in the file this epic starts from. `completionIn`
(`openai-compat.ts:74`) takes the top level or `data`, whichever carries a
choice, and reads `usage` from the same envelope; a 200 that carries the
provider's reason instead is reported as `ClinePass answered with an error: …`
(`saidInstead`, `openai-compat.ts:89`) rather than "no answer". Four tests cover
the wrapped body, a null top-level `choices`, a named error and neither shape.

Two decisions are left, and they are why this is a ticket and not a commit:

- **Unwrap or stream?** Unwrapping is a few lines and keeps one JSON object per
  request. Streaming is the shape ClinePass documents as OpenAI-compliant
  (`choices[0].delta`), and it avoids depending on an envelope that two open
  upstream issues are asking Cline to change — but it means an SSE reader inside
  `chat()`, which deliberately reads one body today. Pick one deliberately and
  write down which, because the cost of the wrong one is the whole provider.
- **The DSML guard.** cline/cline#13348 also reports the gateway serving
  DeepSeek V4 leaking `<｜DSML｜…>` tool-call sentinels into `content` and
  handing back `tool_calls.arguments` as `"{}"` on roughly one tool-bearing run
  in four. Unwrapping does not touch that: a Coder turn would get a tool call it
  cannot parse and reasoning text full of markup. Decide whether to strip the
  sentinels, fail the turn with a reason a person can act on, or keep the coding
  columns off ClinePass's DeepSeek.

Acceptance: a scripted non-streamed reply in the wrapped envelope drives a real
two-turn tool loop, and a ClinePass run either reaches its first tool call or
fails with the provider's own reason.

### CL-9 — Say which ClinePass credential to paste, and offer the ids the plan serves

`providers.ts:138`, `agent-editor.tsx` — XS — independent

Two small gaps, either of which costs an afternoon (Blocker 5):

- The note says "$9.99/mo flat rate … One key for all of them" and links
  `app.cline.bot`; it does not say **Settings > API Keys**, which is where a
  durable key comes from, nor that a token copied out of the extension or the
  CLI dies within the hour. The key field is a paste target with no validation,
  and `GET /models` accepts anything, so this sentence is the only thing that can
  steer it.
- `suggestedModels` is empty (`providers.ts:149`), so the editor shows the
  gateway's 460 ids and a person picks `deepseek/deepseek-v4.1-flash`. Cline's
  ClinePass page names the plan's own slugs — `cline-pass/deepseek-v4.1-flash`,
  `cline-pass/glm-5.3`, `cline-pass/kimi-k3`, `cline-pass/qwen3.7-max` — and says
  to send "the full ClinePass model slug". List those, the way the other
  providers list theirs.

Acceptance: the editor offers the `cline-pass/…` ids with no key pasted, and the
note says where the key comes from and how long it lives.

### CL-10 — Let the assistant read a long file in windows

`turn.ts:39`, `coding-loop.ts:58` — S — independent

`read_file` gains an optional `offset`, and a read longer than the 16,000
character budget comes back as a window that says where it sits instead of two
ends with the middle cut out:

```
[docs/cline-audit.md: characters 0-16000 of 34419]
…16,000 characters…
[More: call read_file with offset=16000.]
```

Landed on this branch: `src/lib/assistant/reads.ts` (`readWindow`,
`outOfRoundsMessage`, nine tests in `reads.test.ts`) with `turn.ts` wired to it —
`readInput` takes `offset`, the tool description says long files come in windows,
and the exhausted-turns message now reports how many files were read, over how
many rounds, and the last thing a tool said. Against this document the first
window carries `## The epic` (11,525), `## Tickets` (13,545) and `### CL-1`
(13,648); the second carries the rest, so the ask that failed on the old read
succeeds on round one.

Acceptance: a 34,000 character file is readable end to end across two calls, and
a run that spends its turns says what it read and what failed.

Measured against ClinePass with the fix in place: the whole 34,419 character
document comes back in three calls (`@0`, `@16000`, `@32000`), the model asks for
the offset without being told to, and it stops re-reading the file — the same ask
that never produced an answer on the old read answered on round 15 of 16, with a
propose call. What it costs is CL-11.

Note, not in this ticket: the coder's `read_file` (`coding-loop.ts:104`) takes
only a `path` too, and a coder asked to change a long file has the same blind
spot and a worse one behind it — `write_file` rewrites the whole file, so a
34,000 character file has to survive the model's output budget as well. Both
want the same first step (a window and an offset) and then a way to replace a
region rather than a file.

### CL-11 — The assistant runs out of rounds before it runs out of questions

`turn.ts:32` — XS — independent

`MAX_TURNS` is 16, and one round is one model call that asks for tools. Reading
this document is three of them. A `create_epic_with_tickets` for its ten tickets
costs more, because every ticket wants a `fileScope`, an order and an acceptance
line, and the model reads code to get those right rather than guess. Measured
twice against ClinePass with the window fix in place:

| Run | Prompt | Rounds used | Ending |
| :-- | :-- | --: | :-- |
| 1 | the tool schemas, no ticket template | 15 | answered, one propose call |
| 2 | the prompt the assistant really sends, `TICKET_TEMPLATE` and all | 16 | out of rounds, no proposal |

So the epic now sits at the edge of the budget rather than behind a wall. Two
ways out, not exclusive: say in the prompt that rounds are finite and to propose
as soon as the ticket list is known, or raise `MAX_TURNS`.

Raising it has a catch worth measuring first. The work happens in the request's
`after()` block (`api/assistant/route.ts`, which sets no `maxDuration`), so the
platform default is what bounds it, and a longer loop that is killed at that
ceiling leaves the message pending with nothing to read — worse than a run that
says it ran out of rounds. Check the deployed limit before changing the number,
and note the loop has no dedupe: `read_file` of the same path in the same window
is paid for again.


## Rejected: point the Claude path at DeepSeek's Anthropic endpoint

`https://api.deepseek.com/anthropic/v1/messages` exists (401 unauthenticated),
and DeepSeek documents an Anthropic-format API — so DeepSeek could ride the
mature path instead, inheriting 64k `max_tokens`, prompt caching, thinking-block
replay and the effort mapping.

Rejected for now, but it is a real option and worth revisiting:

- `requestShape` (`src/lib/agents/models.ts:80`) dispatches off
  `agentModel(model)`, a table of **Claude** models. A DeepSeek id falls through
  to the plainest request (`models.ts:95`). The Anthropic format's effort
  control is `output_config.effort`, which is the same field Formic already
  sends (`coding-loop.ts:322`), so that part would come free — but it is gated
  on a row in the Claude table, and adding DeepSeek ids to a Claude model table
  is the awkward part.
- `anthropicClient` (`anthropic.ts:67`) caches one client per API key and
  constructs `new Anthropic({ apiKey })` with no `baseURL`. It would need the
  base URL in the cache key, or it hands a DeepSeek key a client aimed at
  Anthropic.
- `kind` drives the UI and the models route (`providers/models/route.ts:47`),
  so a provider whose `kind` is `"anthropic"` but which is not Anthropic
  confuses Settings, the editor and the pricing labels.
- CL-2's `max_tokens` fix is needed for Gemini, OpenRouter and Groq regardless.

## Open questions

- Thinking on or off for the Coder? On is better code and higher cost; the CoT
  is re-billed as input each turn while tools are in play. Formic's ceiling
  interaction makes this a money question, not a taste question.
- Who pays for DeepSeek? Code leaves the user's repository for a Chinese
  provider, which `docs/audit.md:72` already flags as needing a liability
  clause. This epic makes that path the recommended cheap one.
- ClinePass is flat-rate, so what does `estimateCostCents` mean there? Answered
  on this branch: nothing. A subscription's marginal cost is zero, so a run on
  one is not charged against the spend ceiling at all and is bounded by its time
  and attempt limits instead. See CL-1.
- Concurrency: DeepSeek's limit is 500 for V4-Pro against 2,500 for Flash, so a
  board full of Pro agents serialises sooner than a board of Flash ones.
- Is sixteen rounds the right ceiling now that a read is bounded? Measured, the
  epic in this document sits at the edge of it (CL-11), and the loop runs inside
  an `after()` block whose duration ceiling is the platform default.

## Evidence

Every claim above, and where it came from.

| Claim | Source |
| :-- | :-- |
| Live ids are `deepseek-flash` (V4.1-Flash) and `deepseek-v4-pro` (V4-Pro-0813) | Models & Pricing |
| Flash peak $0.30 in / $1.20 out per M; V4-Pro $1.32 / $3.96 | Models & Pricing |
| Off-peak is half of peak; peak is 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri, excluding Chinese holidays | Models & Pricing |
| Cache hit per M: Flash $0.006, V4-Pro $0.044 — against $0.30 / $1.32 for a miss | Models & Pricing |
| 1M context, 384K max output | Models & Pricing |
| Concurrency 2500 (Flash) / 500 (V4-Pro) | Models & Pricing |
| Flash does vision, V4-Pro does not; both do JSON, tool calls, Responses and Anthropic APIs | Models & Pricing |
| Legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted and billed at the Flash price | Models & Pricing |
| Base URL is `https://api.deepseek.com`; the Anthropic-format base is `https://api.deepseek.com/anthropic` | Models & Pricing |
| Thinking on by default, effort `high` | Thinking Mode |
| Toggle is `thinking.type`; effort is `reasoning_effort: low/high/max` | Thinking Mode |
| There is no `medium`: `minimal`/`low` map to `low`, and `medium`/`high`/`xhigh` map to `high` | Thinking Mode |
| Anthropic format toggles with `reasoning.effort` (`none` disables) and sets effort with `output_config.effort` | Thinking Mode |
| The response `message` carries `content`, `reasoning_content` and `tool_calls`; the docs recommend appending it to the history as-is | Thinking Mode |
| `content` can be an empty string on a turn that only calls tools | Thinking Mode |
| `temperature`, `presence_penalty` and `frequency_penalty` are ignored in thinking mode, silently rather than as an error | Thinking Mode |
| `top_p` applies only in thinking mode, clamped to 0.95-1.0 | Thinking Mode |
| With `tools`, all previous turns' `reasoning_content` must be passed back | Thinking Mode |
| Without `tools`, it is ignored and not concatenated | Thinking Mode |
| The 400 text | hermes-agent#17212 |
| JSON output needs the word "json", a format example, and a sane `max_tokens` | JSON Output |
| `GET /models` returns `context_window`, `max_output_tokens`, `input_modalities`, `effort.supported_levels`, `effort.default_level` | Lists Models |
| Both live models: 1048576 context, 393216 max output, default effort `high` | Lists Models |
| `none` is not an accepted `reasoning_effort`; thinking is turned off with `thinking.type` | Lists Models |
| System-prompt handling is declared per model: `leading-only` (V4-Pro) or `in-history` (Flash) | Lists Models |
| Caching is on by default, needs no parameter, and matches input prefixes | Context Caching |
| `usage` carries `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` | Context Caching |
| `/v1/models`, `/v1/chat/completions` and `/anthropic/v1/messages` all answer 401, not 404 | `curl`, 28 Sep 2026 |
| A non-streamed ClinePass reply wraps the completion in `data` with a `success` flag, and has no top-level `choices`; its streaming path is compliant | cline/cline#12647 |
| The same wrapper on a tool-bearing non-streamed request, with `message.content: null` and `finish_reason: "tool_calls"` | cline/cline#13348 |
| ClinePass's DeepSeek V4 gateway can leak `<｜DSML｜…>` sentinels into `content` and return `tool_calls.arguments: "{}"`, about one tool-bearing run in four | cline/cline#13348 |
| `stream` defaults to `true`, and a non-streamed reply is documented as a plain OpenAI object | Cline Chat Completions |
| `GET /api/v1/models` answers 200 with a bogus key: 459 models, `deepseek/deepseek-v4.1-flash` among them | `curl`, 28 Sep 2026 |
| Production reports commit `e150a63`, the PR #166 merge, so `stream: false` is live | `/api/health`, 28 Sep 2026 |
| `ClinePass returned no answer.` has one source line, and nothing else in the repo words a failure that way | `grep`, 28 Sep 2026 |
| ClinePass answers a non-streamed request with top-level `data,success`; the completion is at `data.choices[0]`, usage beside it | `curl`, 28 Sep 2026 |
| The shipped `chat()` reads a plain answer, a tool call and a JSON-mode answer out of that envelope, against the live endpoint | `chat()` at `api.cline.bot`, 28 Sep 2026 |
| On a tool-bearing non-streamed reply, `data.choices[0].message.content` is `null`, `finish_reason` is `"tool_calls"`, and the arguments parse clean | `chat()` at `api.cline.bot`, 28 Sep 2026 |
| A two-turn tool loop through the shipped `chat()`, the assistant turn rebuilt without reasoning as Blocker 1 describes, finishes on turn two against ClinePass | `chat()` at `api.cline.bot`, 28 Sep 2026 |
| `deepseek/deepseek-v4.1-flash` (the picker's id) and `cline-pass/deepseek-v4.1-flash` (the plan's slug) both answer 200; a nonsense id answers 404 | `curl`, 28 Sep 2026 |
| A ClinePass account auth token is a WorkOS JWT with `iat`/`exp` 60 minutes apart; the CLI's copy was 110 minutes expired at probe time | `~/.cline/data/settings/providers.json`, 28 Sep 2026 |
| With an expired token, `POST /api/v1/chat/completions` answers 401 `Unauthorized: … re-authenticate your Cline account.` while `GET /api/v1/models` answers 200 | `curl`, 28 Sep 2026 |
| Cline issues durable keys under `Settings > API Keys` for programmatic use, and names the plan's models by their `cline-pass/…` slugs | Cline Authentication, ClinePass |
| Production reports `8c87f9c` (the PR #167 merge) at build `VRs0tGQERoQ1_WsE-yqPs`, so the unwrap is live | `/api/health`, 28 Sep 2026 |
| `docs/cline-audit.md` is 34,419 characters; `truncate` at 16,000 keeps 0-8,000 and 26,419-34,419, so `## The epic` (11,525), `## Tickets` (13,545), `### CL-1` (13,648) and `### CL-9` (23,857) fall in the dropped middle | `wc -c` and offsets over the file, 28 Sep 2026 |
| A 16-round assistant-shaped tool loop against ClinePass (`deepseek/deepseek-v4.1-flash`), the real schemas and the real `truncate`, never produced an answer: `converged=false invalidArgs=0 turnsWithDsml=0`; 32 tool calls in that run, 18 reads cut short at 16,038 characters across both runs | probe, 28 Sep 2026 |
| Five tool calls in those runs asked for a range or an alias (`:1200-5000`, `?range=4000-12000`, `#L60`, `docs/../docs/cline-audit.md`, `docs/legal/../cline-audit.md`) and every one was answered `does not exist on main` | probe, 28 Sep 2026 |
| The failing ask's answer was `I read a lot and did not reach an answer. Try a narrower question.`, whose only source line was `turn.ts:251` at `8c87f9c` | the board, then `grep`, 28 Sep 2026 |
| With `readWindow` wired in, the same loop read the whole 34,419 character document in three calls (`@0`, `@16000`, `@32000`) and answered on round 15 of 16 with a propose call | probe, 28 Sep 2026 |
| The same loop with the assistant's real prompt (ticket template included) used all 16 rounds reading and ended `converged=false proposals=0`, so the round budget is the next constraint | probe, 28 Sep 2026 |
| `MAX_TURNS` is 16 at `turn.ts:32`, and `api/assistant/route.ts` sets no `maxDuration`, so the loop's ceiling is the platform default | `grep`, 28 Sep 2026 |

Sources, all read on 28 September 2026:

- Models & Pricing — https://api-docs.deepseek.com/quick_start/pricing
- Lists Models — https://api-docs.deepseek.com/api/list-models
- Thinking Mode — https://api-docs.deepseek.com/guides/thinking_mode
- JSON Output — https://api-docs.deepseek.com/guides/json_mode
- Context Caching — https://api-docs.deepseek.com/guides/kv_cache
- Tool Calls — https://api-docs.deepseek.com/guides/function_calling
- hermes-agent#17212 — https://github.com/NousResearch/hermes-agent/issues/17212
- Cline Chat Completions — https://docs.cline.bot/api/chat-completions
- cline/cline#12647 — https://github.com/cline/cline/issues/12647
- cline/cline#13348 — https://github.com/cline/cline/issues/13348
- Cline Authentication — https://docs.cline.bot/api/authentication
- ClinePass — https://docs.cline.bot/getting-started/clinepass

Repo paths above are relative to the repository root and were checked against
commit 6844810 on `main` plus the PR #166 branch. Blocker 4 and CL-8 were found
after that: on `e150a63`, the PR #166 merge, which is what production reports at
`/api/health`. The `src/lib/llm/openai-compat.ts` lines are taken from the file
with the unwrap CL-8 describes already applied.

Blocker 4 was closed by PR #167, merged as `8c87f9c` and live in production at
19:50:51Z on 28 September 2026 (`/api/health`, build `VRs0tGQERoQ1_WsE-yqPs`).
`chat()` was then run against `api.cline.bot` itself — a plain question, a
tool-bearing question and a JSON-mode question — and read all three out of the
`data` envelope: contents, a `tool_calls` array with parseable arguments, and the
token counts. The 401 and the slug observations under Blocker 5 come from the
same probes, which are the first time this path has been exercised with a working
credential.

Blocker 6 came from the board rather than from a probe. An ask came back `I read
a lot and did not reach an answer. Try a narrower question.`, which was
`turn.ts:251` at `8c87f9c`: sixteen rounds of tool calls and no final answer. The
board keeps one line for a failed ask, so those rounds are gone by the time
anyone looks at it. A throwaway harness then ran the same loop outside Formic -
the same three tool schemas, the same 16-turn budget, the same `truncate`, the
same provider and model - reading this repository's own checkout instead of
GitHub through the API, and printing what each round did. Run against Cline's
gateway it never converged: eighteen reads of the document, none of them whole,
and sixteen rounds with no answer. Re-run with `readWindow` in place, the same
loop read the whole document in three calls and answered on round 15 with a
propose call; re-run with the assistant's real prompt it used all sixteen rounds
on code reads and never proposed, which is CL-11.
