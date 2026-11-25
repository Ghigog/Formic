# PM chat: a real Claude session per board

**Status:** planned 2026-11-21. Four pull requests, in order below. Tick boxes
as work lands; this file is the memory of the plan, so keep it current. Any
agent picking this up should read all of it first.

## Why

The PM chat should feel like talking to Claude in the desktop app: it
remembers the conversation, looks things up while it works, changes code,
opens pull requests and sorts out the board, and it tells you what it did.

Today it does not. A real exchange on the Juice board (2026-11-21) showed:

- **It repeats itself.** It re-sent a whole report twice ("my last answer got
  cut off"), because it never saw its own earlier work, only a flattened
  transcript.
- **It guesses which card you mean.** "e122 t1" was matched to an old `T-1`,
  so it was handed the wrong card and answered about EPIC-119-T1.
- **Everything is a proposal.** Opening its own PR, re-running CI and adding a
  ticket each needed an Approve click.
- **Formic's notices speak in the PM's voice.** "X is done", "Added
  EPIC-122-T3", "Opened pull request #726" and "Re-running…" are posted as PM
  messages, land between a question and its answer, and go back into the PM's
  history as things it said. "Can you give me the answer first?" got
  "Stopped." and a notice instead of an answer.
- **"Is done" fires too early.** Follow-ups are announced when the Reviewer
  approves (`src/lib/review/pipeline.ts`, the `proposeFollowUps` call after
  "Finished as far as the review goes, merged yet or not"), not on merge.
- **Text can't be copied reliably**, so the person can't tell whether they
  have a whole message.

## Root cause

A CLI PM (Claude Code, the usual setup) answers each message with a **new
GitHub Actions job from scratch** (`src/lib/assistant/turn.ts`, `answer` →
`startCliAsk`). The job gets the conversation pasted in as text
(`cliPrompt`), a handful of cards pre-read by regex (`cliReports`), and must
reply with one JSON object (`cliAnswerSchema`). No memory, no live lookups,
no streaming, and a format it often gets wrong (`askAgain`).

API-key PMs (Anthropic, OpenAI-compatible) run in the in-process tool loop in
the same file and already keep real history. They keep that loop; PR 1 fixes
apply to them too.

## Decisions (agreed with the board owner)

1. **Where it runs.** A Claude Code session per board, resumed for every
   message (`claude --resume <id>`).
   - **With E2B** (a key on the project owner or `E2B_API_KEY` on the server):
     the session lives in an E2B sandbox with the repo checked out, paused
     between messages. Replies start in seconds and stream.
   - **Without E2B:** the same session runs in GitHub Actions (or GitLab CI).
     At the end of each job Formic saves the session file; the next job
     restores it and resumes. Same memory and tools; each message takes about
     30 to 60 s to start. The chat shows "Starting…" with a live timer, and a
     one-line hint that adding E2B makes replies faster.
   - Never on the Lightsail server itself: it has 1 GB of memory
     (`docs/aws.md`) and cannot run Claude Code beside a build.
   - The session file format is the same in both places, so a board can
     switch without losing memory. Formic picks E2B when a key is set.
   - It uses the person's Claude Code subscription token, as today.
2. **It acts, then says what it did.** It creates tickets and Epics, moves
   cards, re-runs CI, writes code, pushes and opens PRs without asking. It
   asks first (a proposal with Approve / Dismiss) only for:
   - closing, archiving or deleting a card;
   - merging a pull request;
   - creating **optional** cards: nice-to-haves and follow-ups the person did
     not ask for.
3. **It may push to any ticket's branch, without asking.** A ticket that gets
   stuck or asks a question wakes the PM; the PM investigates, fixes it on
   that branch, re-runs checks and tells the person in one line. The PM also
   tidies the board when it gets messy (missing dependencies, overlapping
   scopes, stale branches that need main).
4. **Guests keep their context.** The person or the PM can summon an agent
   into the chat. A guest is only useful with its real context, so Formic
   saves each agent run's Claude Code session file, and summoning that agent
   resumes its own session. Sentinels resume from their last audit.

## Design

### The chat stream (PR 1)

- Messages have a **kind**: `person`, `pm`, `guest`, `notice`. Formic's own
  posts (`postPmMessage`, follow-ups, stall messages, rubric-fix messages,
  "Opened pull request", "Re-running") become `notice`s.
- Notices render as compact timeline lines (icon, one line, card links), not
  PM bubbles. They are given to the model as events (`[Board: EPIC-122-T3
  added]`), never as the PM's own words.
- **Answer first.** A notice that lands while a reply is pending is shown
  above the pending reply, not between the question and its answer; the reply
  always sits directly under the message it answers.
- **"Is done" only on merge.** The review-approved call announces nothing;
  `proposeFollowUps` runs on merge only. Needed follow-ups are added with a
  `dependsOn` on the ticket they came from.
- **Copy button** on every message (PM, guest and the person's own), copying
  the raw Markdown. Fix whatever stops text selection in the chat panel.
- **"Stopped."** only when the person pressed Stop. A new message no longer
  cancels the pending one; it queues behind it (already the route's intent).

### The PM session (PR 3)

- **One session per board**, row `PmSession { projectId, sessionId, where:
  "e2b" | "actions" | "gitlab", sandboxId?, fileCipher, bytes, summary,
  updatedAt }`.
- **Turn:** person's message → queue → resume the session with the new
  message plus any notices since the last turn → stream assistant text and
  tool calls to the chat over the existing event bus → save the session file
  → finish.
- **Tools:** Claude Code's own (read, edit, bash, git in the checkout) plus
  Formic's MCP server (`src/lib/mcp`) with the PM's board-scoped token. New or
  extended MCP tools the PM needs: `card_status` (live column, runs, PR,
  checks, failed log), `rerun_checks`, `update_branch_from_base`,
  `open_pull_request`, `answer_card_question`, `add_dependency`, plus the
  existing card tools. Approval-gated tools return a proposal instead of
  acting (see Safety).
- **Pushes** use git in the checkout with a repo token. The PM works on
  `formic-pm/<board>-<n>` branches for its own changes and may push to ticket
  branches under the branch lock.
- **Wake-ups:** a ticket blocked, failed or asking a question enqueues a PM
  turn with the card's report as the message, subject to the fix cap.
- **Streaming in Actions:** the job already streams through `FORMIC_STREAM`;
  the chat shows those lines live as the PM's reply.
- **Guests** (PR 4): each agent run uploads its session file at the end
  (Actions artifact → Formic, encrypted). Summoning resumes it read-only in
  the PM's sandbox or a job.

### Fallback ladder

1. E2B sandbox, resumed. 2. E2B sandbox recreated from the saved session
file. 3. Actions or GitLab job from the saved session file. 4. A fresh
session seeded with the stored summary, and a one-line "reconnected" notice.
A reply is slower down the ladder, never lost.

## Safety (from the risk assessment, 2026-11-21)

Each item is required, not optional. Enforce on the server, never only in a
prompt.

| # | Risk | Mitigation | PR |
|---|------|------------|----|
| 1 | **Prompt injection with real power.** The PM reads PR comments, CI logs, issues, repo files and agent notes that anyone can write, and now acts without approval. | Approval rules enforced inside the MCP tools: close, archive, delete, merge and optional-card creation always return a proposal, whatever the model asks. Pushes allowed only to the board's own repo, only to `formic-pm/`, `formic-staging/` and ticket branches; never to the base branch; never to `.github/workflows/` (rejected before push, as `write_file` does today). Every action is a timeline notice. | 2, 3 |
| 2 | **The PM's token is too powerful.** MCP access tokens act as the user across every board (`src/app/api/mcp/route.ts`, `mcpServerFor(user)`). | A new token kind: one board, one session, short-lived (hours), revoked when the session ends, carrying only the PM's tools. `verifyToken` returns the board scope; `mcpServerFor` refuses any other board. | 2 |
| 3 | **Runaway fix loops.** Stuck → PM fixes → fails → wakes again, burning usage overnight. | At most 2 PM fix attempts per ticket per head change, then one clear message to the person and stop. Auto wake-ups rate-limited per board (for example 6 an hour). The cap is a board budget setting like the others (`docs/limits.md`). | 3 |
| 4 | **Two writers on one branch.** | A branch lock row in the database. The PM pushes only when no agent run holds the branch; a ticket run waits while the PM holds it. Fast-forward pushes only, never forced. Lock expires on a timeout so a crash never wedges a branch. | 3 |
| 5 | **Subscription limits.** Auto wake-ups spend the person's Claude usage; hitting the cap stalls ticket agents on the same token. | A daily PM allowance for auto wake-ups, separate from the coders'. At the limit the PM says so once and waits; no retry storm. Person-typed messages are never blocked by the allowance. | 3 |
| 6 | **Session files hold secrets.** | Encrypted at rest with the API-key cipher. Size cap (compress; refuse above the cap and fall back to the summary). Keep only the latest per board or agent. Deleted on Clear and with the board. | 3, 4 |
| 7 | **Sessions break or vanish** (E2B retention, failed upload, Claude Code version change). | The sandbox is a cache; the session file is the truth; the fallback ladder above. Formic keeps a short running summary of the conversation and board after each turn. | 3 |
| 8 | **Long sessions bloat.** | Claude Code's own compaction, plus a fresh session seeded with the summary on Clear or past a size limit. | 3 |
| 9 | **PMs not on Claude Code.** | API-key PMs keep the in-process loop in `turn.ts`. PR 1 applies to every PM. The session work is Claude Code only. Nobody loses their setup. | 1, 3 |
| 10 | **Rolling out the workflow.** Merging a change to `.github/workflows/formic-agent.yml` (generated by `src/lib/runner/workflow.ts`) auto-deploys and Formic then replaces the file in every connected repo. A bad version breaks every agent run. | Additive only: new inputs optional, old runs behave as before. Tested end to end on a scratch repo before merge. Called out in the PR. | 3, 4 |
| 11 | **GitLab parity.** GitLab boards run through `src/lib/runner/gitlab-ci-config.ts`. | Build the session layer once, for both. If GitLab lags, it keeps today's behaviour rather than half working. | 3 |
| 12 | **Waiting in Actions.** | "Starting…" with a live timer; streaming once the job is up. | 3 |
| 13 | **Guests acting out of turn.** A resumed agent session could push to its branch. | Guests get read-only tools plus chat. The PM does the acting. | 4 |
| 14 | **Migrating old chats.** | History stays readable. The first new session is seeded with a summary of it, not a replay. | 3 |
| 15 | **Testing gaps** across sandbox, Actions, MCP and streaming. | Unit tests on a fake sandbox and fake runner; one e2e test (in-memory repository) of message → tool call → streamed reply. Repo rules in `docs/testing.md` apply. | all |

What does not change: the ticket pipeline, Sentinels, CI, review and merge
rules. The PM acts through the same board rules a person follows (a move the
board refuses still fails).

## Pull requests

Each is usable on its own. PRs 1 and 2 touch different files and run in
parallel; 3 needs both; 4 needs 3.

### PR 1: Chat foundation

Files: `src/lib/assistant/*` (message kinds, notices, history),
`src/components/board/assistant.tsx`, `src/lib/hooks/use-assistant*.ts`,
`src/lib/review/pipeline.ts` (follow-up timing only),
`src/lib/agents/follow-ups.ts`, `prisma/` (message kind column), the
repositories in `src/lib/db/`.

- [x] Message `kind`; every Formic-authored post is a `notice`.
- [x] Notices render as timeline lines; given to the model as events, not as its words.
- [x] Replies sit directly under the message they answer; notices never split them.
- [x] Follow-ups and "is done" only on merge; needed follow-ups depend on their ticket.
- [x] Copy button on every message; text selection works in the panel.
- [x] "Stopped." only on an explicit Stop.
- [x] Tests for each; e2e for the panel.

How it landed (PR 1):

- `kind` is a column on `assistant_message` (`person`, `pm`, `guest`,
  `notice`), backfilled from role and speaker. `src/lib/domain/chat.ts` holds
  `kindOf`, `noticeEvent` and `threadOrder`. Every Formic post goes through
  `postPmMessage`, which writes a `notice`; so does a proposal's outcome
  ("Opened pull request", "Re-running").
- `threadOrder` is what the panel shows and what the model reads: a notice
  between a person's message and a reply queued for it (written within 30 s,
  in the same request) moves above the message. A reply Formic starts later
  on its own (a wake-up) is not treated as answering the person.
- The model gets a notice as a user-side `[Board: …]` event, joined to its
  neighbours for API PMs (`forModel`) and under its own `### Board` heading in
  the CLI prompt.
- Stop sits on the pending reply and sends its id; Send never turns into Stop.
  Stopping a queued reply leaves the running one alone.
- `proposeFollowUps` runs on Formic's merge and on a person's merge
  (`markMergedExternally`), never on approval.

### PR 2: Board-scoped PM tokens and server-side approval

Files: `src/lib/access-tokens*`, `src/app/api/mcp/`, `src/lib/mcp/*`,
`src/lib/assistant/actions.ts` (shared action checks), `prisma/`.

- [x] Token kind scoped to one board and one session, short-lived, revocable, tools-limited.
- [x] `mcpServerFor` enforces the board scope.
- [x] MCP tools the PM needs: `card_status`, `rerun_checks`, `update_branch_from_base`, `open_pull_request`, `answer_card_question`, `add_dependency` (reusing the existing action code).
- [x] Approval gate inside the tools: close / archive / delete / merge / optional cards return a proposal posted to the chat.
- [x] Branch rules: no base branch, no `.github/workflows/`, only the board's repo.
- [x] Tests, including a fooled-model test (the tool refuses whatever it is told).

Landed as: `createPmToken` / `revokePmTokens` in `src/lib/access-tokens` (4 h
default, 12 h cap, `projectId` + `sessionId` on `access_token`, cascade with
the board, hidden from Settings); `PM_TOOLS` and the gated tools in
`src/lib/mcp/server.ts` and `src/lib/mcp/pm-tools.ts`; branch rules and the
PM's direct actions in `src/lib/assistant/actions.ts`, plus a
`merge_pull_request` proposal type. A move to Done is a merge, so it is
gated too. Optional cards are caught server-side when a create repeats a
"nice" follow-up an agent left; a nice-to-have the PM invents and files
through `create_backlog_card` cannot be told apart from a request, so the
PM's prompt (PR 3) must send those through `propose_card`. PR 3 calls
`createPmToken` when a session starts and `revokePmTokens` when it ends.

### PR 3: The PM session

Files: `src/lib/assistant/turn.ts` (CLI path), new `src/lib/assistant/session/`,
`src/lib/sandbox/*` (pause / resume), `src/lib/runner/workflow.ts`,
`src/lib/runner/gitlab-ci-config.ts`, `src/lib/runner/runner.ts`, `prisma/`,
`docs/limits.md`.

- [x] `PmSession` store, encrypted, size-capped, summary kept per turn.
- [x] E2B: create, pause, resume, recreate from file.
- [x] Actions and GitLab: restore session file, resume, upload at end (additive workflow inputs).
- [x] Streaming into the chat; "Starting…" timer; E2B hint when absent.
- [x] Wake-ups from stuck tickets; fix cap; per-board rate limit; daily PM allowance.
- [x] Branch lock shared with ticket runs.
- [x] Fallback ladder; old chats seeded from a summary; Clear starts fresh.
- [x] API-key PMs unchanged.
- [ ] Scratch-repo end-to-end check of the new workflow before merge.

How it landed (PR 3a; 3b adds E2B, wake-ups, the fix cap, the rate limit
and the daily allowance):

- `pm_session` holds one row per board: Claude Code's session id, the
  session file (gzipped JSONL, sealed with the vault, at most 8 MiB, else
  dropped and the next turn starts fresh), the running summary
  (`runningSummary`, the latest 30 lines, at most 6,000 characters, kept
  after every turn), the current turn's job and its one-time handoff.
  Deleted on Clear (`endPmSession`) and with the board (cascade).
- `src/lib/assistant/session/`: `startSessionTurn` builds the turn's message
  (`transcript.ts`: only what is new since the PM's last reply; a fresh
  session gets `sessionSystemPrompt` plus the summary instead of a replay),
  mints a PM token for the session and dispatches an `ask` run with the new
  `session` input. The job collects the file and the token once from
  `/api/runner/session` (signed for its job, 90 minutes), runs
  `claude --resume <id>` (or `--session-id` when fresh) with
  `--mcp-config` for Formic's MCP server, and posts the file and its
  checkout's branch back. `finishSessionTurn` revokes the token, lands the
  change, posts the session's own words as the reply (no JSON), and on a
  resumed turn that failed starts it again fresh, with a "Reconnected"
  notice. Stop cancels the job and revokes the token.
- The workflow change is additive: one optional input, two steps that only
  run with it, and a session branch in the claude command that only runs
  when the restore step set its variables. A repository whose workflow (or
  GitLab job) predates it is never sent the input (`runnerTakesSession`),
  and its PM answers the old way until the setup PR refreshes it.
- The PM cannot push. The job keeps its commits on the answer's
  `-change` staging branch, as before, and `landPmChange` moves them:
  never the base branch or `.github/workflows/`, a ticket's branch only as
  a fast-forward while no agent run holds it, anything else onto
  `formic-pm/<board>-<nonce>` with a pull request. The branch lock is a
  lease (`src/lib/runner/branch-lock.ts`): a ticket run holds its branch for
  its job's length, the PM for one move; a run waits up to a minute for the PM.
- Streaming: the reporter's lines for a session turn are written into the
  pending reply (its words, and a `›` line per tool call); the panel shows
  them live, and "Starting… 0:12" until the first arrives.
- The scratch-repo check is still to do: it needs a repository with the new
  workflow and a Claude Code token.

How it landed (PR 3b, part 1: wake-up limits):

- Every wake-up passes `admitWake` (`src/lib/pm/wake-gate.ts`) first. Each
  wake-up, each commit the PM lands on a ticket's branch and each limit it
  said is a `pm_wake` row (deleted with the board).
- Fix cap: the PM's looks at a stuck ticket are counted back to where
  someone else last moved its branch (`fixAttempts` in
  `src/lib/domain/pm-wake.ts`). A commit the PM lands links the head it
  fixed from to the new one, so its own pushes never reset the count; an
  agent's or a person's push does.
- Hourly and daily (UTC) limits count every ticket's wake-ups together.
  A question is never capped by fix attempts, only by those two.
- Held: the limit's line is said once (per ticket and head, per hour, per
  day) and the stop goes to the person as it did before the PM looked at
  stops. A person's own message is never held.
- All three are per-board settings (`pmFixCap`, `pmWakesPerHour`,
  `pmWakesPerDay` on `project`, null for the default), in Settings under
  "PM wake-ups", listed in `docs/limits.md`.
- A Claude Code PM is told to fix a stuck ticket on its branch, rerun its
  checks and say what it did in one line; an API PM still explains and
  proposes.

How it landed (PR 3b, part 2: E2B):

- The person's Claude Code token is kept on the PM's agent, sealed like an
  API key (decided with the board owner, 2026-11-21: it is only used to start
  the PM's sandbox; anyone who breaks into the server could use it, as they
  could the API keys already kept there). Only Claude Code keeps one
  (`keepsKey` in `src/lib/domain/providers.ts`); every other CLI agent's
  sign-in stays in the repository's secrets. A key never survives a
  provider change. The field is in the PM agent's editor, "Claude Code token".
- Pasted once: saving it also writes the same value into the agent's
  repository secret (an Actions secret on GitHub, a masked CI/CD variable on
  GitLab) in the repository of the board the person is on, with their own
  access (`saveTokenToRepo`, `VcsClient.saveAgentSecret`). Neither host lets
  Formic read a secret back, which is why the sandbox needs its own copy. If
  the write fails, the agent is still saved and the editor says why, so the
  person can add the secret by hand or save again.
- A turn runs in E2B when the agent keeps a token and the board owner has
  their own E2B key (never the operator's shared key, whose monthly minutes a
  warm session would spend). Otherwise it runs in CI exactly as in 3a.
- `src/lib/assistant/session/sandbox.ts` is the narrow port over the SDK
  (create, connect, run, start, read, write, pause, kill), with a fake in
  tests. `e2b-turn.ts` runs a turn: resume the paused sandbox (ladder step 1),
  or make one again, install Claude Code, clone, and write the saved session
  file in (step 2); a sandbox that cannot be had sends the turn to CI
  (step 3); a resumed session that fails starts fresh from the summary
  (step 4, unchanged). The database file stays the truth.
- Formic drives the sandbox itself, so nothing is collected over the
  internet. The repository token is only on the command line of the fetch
  before the turn and the push after it, never in the checkout's config or
  the agent's environment; the PM still cannot push. Its commits go to the
  turn's staging branch and `landPmChange` moves them, as in CI.
- Streaming: Claude Code's stream-json is read as it prints and written into
  the pending reply. Stop kills the command; the session keeps its previous
  file. Clear kills the sandbox. After each turn the sandbox is paused.
- A turn lives in the Formic process that started it. One a restart lost is
  failed by the idle sweep (`recoverLostSandboxTurn`), its token revoked, with
  "Formic restarted while the PM was answering".
- Hint: while a Claude Code PM with no token kept starts in CI, the chat says
  replies start in seconds with E2B and what to add.
- Not done: killing the sandbox when a board is deleted (E2B's own retention
  reclaims a paused one).

How it changed (2026-11-25, after wake-ups spent a whole subscription):

- The PM wakes only for an agent's question or a person's message. A stall
  (stuck, failed, out of reviews) is a notice to the person and never starts
  a PM turn. This overrides decision 3's "a ticket that gets stuck wakes the PM".
- A PM turn that fails on a usage limit is not a broken session: the session
  file is kept, nothing is retried (no "Reconnected" fresh start), and the
  PM's agent is marked out of usage until the reset, so question wake-ups
  wait too.
- Each turn is bounded, on the agent's own model: a wake-up for at most 10
  minutes and 30 steps, a person's message for 20 minutes and 80
  steps (steps in E2B only; CI has the job timeout). A turn that ran out is
  not started again fresh.
- A turn's tokens are recorded on its reply and count toward the PM agent's
  token allowance, which now gates the PM like any column.
- Wake-ups are also capped across every board one person owns (12 an hour,
  40 a day); the per-board defaults stay 6 and 20.
- The golden bell restarts at most 5 cards every 10 minutes across all of
  one person's boards, instead of every stopped card at once.
- A session whose last call carried more than 150,000 tokens starts its next
  message fresh from the summary (one notice), and the file cap is 1 MiB.
- The PM is woken for one ticket's questions at most four times while its
  branch stays put; the next question goes to the person.
- A wake-up's token is marked as one (`PM wake-up`), and its tools let it
  start new agent work once: a second move into a working column becomes a
  proposal, a second new Epic is refused with a line to tell the person
  instead. Answering questions agents wait on is never limited: unblocking
  them is the PM's job. A person's own turns are not limited this way.
- Outside the PM: when the Reviewer approves the same commit twice while CI
  is red, the ticket stops for the person instead of being reviewed again.

### PR 4: Guests with memory

Files: `src/lib/runner/workflow.ts` (upload session at run end),
`src/lib/assistant/guests.ts`, session store from PR 3.

- [ ] Each agent run saves its session file, encrypted, latest per agent and card.
- [ ] Summoning resumes it, read-only tools plus chat.
- [ ] Sentinels resume from their last audit.
- [ ] Tests.
