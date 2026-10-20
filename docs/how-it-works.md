# How Formic works

The detail behind the README: what agents are told, how they run, and how
the board talks to GitHub.

## Conventions every agent follows

Whatever an agent's prompt says, Formic adds these after it:

- **The ticket template.** Every ticket, from the Architect or the
  assistant, has a user story ("As a…, I'd like to…, so that…"), acceptance
  criteria as Gherkin scenarios (given, when, then), and requirements (the
  how) only when the approach is not already obvious. The story carries the
  what and the why, so there is no separate context or description. It is a
  schema, not advice: a ticket missing a required part goes back to the
  agent to fix. Tickets store it as Markdown, so it reads well in the GitHub
  issue and the pull request.
- **Engineering practices**, as defaults with judgment: test first (TDD), the
  domain's own words throughout (ubiquitous language), domain-driven design
  for rich domains, hexagonal architecture where there are real I/O
  boundaries, SOLID where it earns its keep, and the simplest change that
  meets the criteria. Each applies only where it makes the code simpler,
  and the repository's own conventions (its CLAUDE.md, AGENTS.md, or how
  the code around the change is written) win where they differ.
- **Product conventions:** user stories in the same form, and the product's
  own vocabulary.

They live in `src/lib/agents/prompts.ts` and `src/lib/agents/decomposition.ts`.

## The assistant

The top bar has an ask box. Ask anything about the repository or the board,
and the answer pulls down over the board; the arrow at its bottom right
rolls it back up, and the conversation is there next time.

- It runs on any saved agent, picked in the shade, with no built-in prompt.
  An API agent answers in seconds. A CLI agent on your plan (Claude Code,
  Codex, Gemini CLI) answers from GitHub Actions in a minute or two.
- It reads the repository (an API agent through GitHub, a CLI agent in its
  own checkout) and sees the board.
- It can propose work: a Backlog item for the Product Agent, or an Epic with
  its tickets straight into To Do, for work that is already planned, such as
  a ticket list in the repo. Tickets get the Architect's checks (file scopes,
  a safe dependency graph). Nothing happens until you press Approve.
- It never changes code. Code changes are tickets, and go through the file
  scope, pull requests and CI like everything else.

## Work tracked as GitHub issues

Every Epic is filed as a GitHub issue in its repository, and each of its
tickets as a sub-issue. They move with the board:

- A `formic: <column>` label follows the card, and `formic: needs a human`
  marks one that stopped.
- A comment marks the moments worth a notification: the PRD written, work
  started, a pull request opened, a stop and its reason, a merge.
- A ticket's pull request says `Closes #N`. Merged tickets and shipped Epics
  are closed.

Formic does this itself, not through the agents' prompts, so it works the
same with every provider and costs no tokens. A repository without Issues
access still runs; the board just says nothing on GitHub.

### The other direction: an issue you already wrote

Label an issue `formic: intake` and Formic takes it from there: one ticket in
To Do, drafted by the Architect Agent straight from the issue's text. The issue
you labelled is then the one Formic tracks that ticket by — its label becomes
`formic: <column>`, and the ticket's pull request says `Closes #42`. So the
issue you wrote is the one that closes when the work merges, rather than a
second issue about it appearing beside it.

- The label is the opt-in. Nothing without it is imported, and nothing is
  imported twice.
- The title and the body are read once, at import. Editing the issue afterwards
  does not edit the ticket, and taking the label off does not take the ticket
  away — the label is a door, not a leash.
- On a deployed board GitHub's `issues` webhook makes this immediate. On a
  laptop GitHub cannot reach you at all, so the board's own sweep finds it
  within about half a minute instead (`docs/local.md`).

## Agents per column

Each column's header has an agent menu. An agent is a template: a name, an
AI provider, that provider's API key, a model, and a prompt that starts from
the column's built-in one. Templates are saved once and can run any column
on any board, so one board can use DeepSeek for Product, Gemini for the
Architect, and Claude for the Coder.

Providers: Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, Groq and
ClinePass. Claude runs on Anthropic's own API; the rest share OpenAI's format, so
adding another is one entry in `src/lib/llm/providers.ts`. The model list in
the editor is fetched live from the provider with the key you entered.

Signed in with GitHub, a column with no agent does not run: its cards stop
and say to pick one. No key is ever used that the board's owner did not put
on a template. For the Coder and Reviewer, the platform's coding rules (stay
in the file scope, no git) are appended to whatever the prompt says. Keys
are encrypted at rest and never sent back to the browser.

In local mode, a column with no agent runs Claude on the server's
`ANTHROPIC_API_KEY`, or the mock agents without one.

### CLI agents on your own plan

Any column can run a CLI people already pay for, instead of an API key:

| Agent | Credential | How to get it |
| --- | --- | --- |
| Claude Code | Claude Pro, Max, Team or Enterprise token | `claude setup-token` on your computer. Lasts a year. |
| Codex | ChatGPT sign-in, or an OpenAI key | `codex login`, then paste `~/.codex/auth.json`. |
| Gemini CLI | Gemini API key (free tier works) | https://aistudio.google.com/apikey |

They run in the repository's own GitHub Actions, not on Formic's server:

1. The first time, Formic opens a pull request adding
   `.github/workflows/formic-agent.yml`. A person merges it once.
2. Each run, Formic stores the credential as a repository secret and starts
   the workflow. The agent works on a fresh checkout and pushes to a
   `formic-staging/` branch.
3. When the run finishes (the Workflow run webhook), Formic checks the
   change against the ticket's file scope, fast-forwards the ticket's branch
   to it, deletes the staging branch, and opens the pull request. CI, fixes
   and the merge go through the same loop as every other agent.

The planning columns (Backlog, To Do, Done) run the same workflow in an
answer mode. The agent reads the repository and writes its answer (the PRD,
the ticket graph, or the showcase) to a file; the workflow throws away
anything else it touched and pushes only that answer. Formic checks it
exactly as it checks an API agent's answer, and sends a wrong one back as a
correction (twice for the PRD, three times for the ticket graph).

Nothing the agent does reaches a real branch before the scope check. Formic
never force-pushes, and the only branches it deletes are its own
`formic-staging/` ones.

## The rules that keep it safe

**File scope is the concurrency contract.** Tickets declare directory prefixes
they may touch. The Architect Agent's graph is validated server-side for
cycles and for scope overlap between tickets that could run at the same time,
and a Coder Agent's diff is checked against its scope before it may commit. A
prompt asking nicely for isolation is not a boundary. A running ticket's
scope is a reservation on the repository, not just its board: a ticket on
anyone's board that needs the same files waits in In Progress until it is
free, decided under a lock in the database so every server instance agrees.

**Done means merged into the base branch.** A ticket merges into its
project's base branch only after the Reviewer Agent approves it and CI is
green. To keep a person between agents and the base branch, set
`MERGE_TARGET=integration`: agents then merge into `formic/integration`, which
is kept up to date with the base branch before every ticket starts, and
promoting it is that person's click. Either way the merge lane is serialized:
one merge in flight at a time per repository and branch, across every board
and server instance, each brought up to date with the last and merged only
once CI passes on exactly that head. A ticket can also stack on the open pull
request of the one it depends on, rather than wait for it to merge.
`docs/concurrency.md` has all of it.

**The local sandbox provider is not isolation.** It runs child processes on the
host with host network and filesystem access. It exists so the system can be
built and tested without an E2B account. Use E2B for anything running
model-authored code you have not read.

## GitHub webhook

PROT-07 reacts to CI. With a GitHub App, its webhook covers every installed
repository (see `docs/vercel.md`). In local mode, point a repository webhook at
`/api/webhooks/github`, content type `application/json`, secret matching
`GITHUB_WEBHOOK_SECRET`, and subscribe it to **Check runs**, **Check
suites**, **Workflow runs** and **Pull requests**. Without the secret the endpoint returns 503 and handles nothing —
an unsigned delivery can start an agent, so it is never accepted.

Deliveries are idempotent on `(pull request, head sha, check)`, not on the
delivery id, so a redelivery under a new id is still the same result and still
does nothing. A result about a commit that is no longer the head is dropped.
