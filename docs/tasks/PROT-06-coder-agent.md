# PROT-06 — "Coder Agent" execution loop

**Depends on:** PROT-04, PROT-05
**Size:** XL
**Owns stages:** 5 — Code Run, 6 — PR Opened

## Goal

A ticket moved to In Progress is implemented by an agent in a sandbox, tested,
committed, pushed to a branch, and opened as a PR.

## Scope

- Triggered on ticket transition to In Progress, gated on dependencies met.
- Durable workflow (Temporal or Inngest) wrapping the run so a crashed worker
  resumes rather than losing the sandbox.
- Agent loop: read ticket + file scope, edit files, run tests, iterate on
  failures, commit.
- **File scope enforcement:** diff is checked against the ticket's declared
  `file_scope` before commit. Out-of-scope edits fail the run with a clear
  reason.
- Branch push and PR creation via the GitHub API, PR body linking back to the
  ticket.
- Live streaming into the sandbox inspector: terminal output, file diffs as
  they are written, current step.
- Terminal states written back: `in_review` on PR open, `failed` with reason
  otherwise.

## Out of scope

- CI handling and merge (PROT-07).

## Acceptance criteria

- A ticket with a real file scope produces a real PR against the configured
  repo, with tests run inside the sandbox.
- An agent that tries to edit outside its file scope fails the run; no branch
  is pushed.
- Killing the worker mid-run and restarting resumes or cleanly fails — it never
  leaves an orphaned sandbox.
- Two tickets with disjoint file scopes run concurrently without interfering.

## Notes and risks

- **Build this on the Claude Agent SDK rather than hand-rolling the loop.** The
  PRD describes "send ticket details to LLM to generate bash/code commands" —
  that is a coding harness, and writing one is weeks of work that already
  exists as a library with file tools, bash, context management and
  permissions. The sandbox still comes from PROT-05; the harness does not need
  to be original.
- Model: `claude-opus-5`, effort `xhigh` for coding work. Do not downgrade for
  cost without measuring — a cheaper run that needs three retries is not
  cheaper.
- Retry policy needs a hard ceiling. An agent looping on a failing test is the
  single most expensive failure mode in this system. See PROT-12.
- This ticket is doing four jobs (trigger, workflow, agent, VCS integration).
  Consider splitting it once PROT-05's interface is settled.

## As built

- The loop is a Messages API tool-use loop (`src/lib/agents/coding-loop.ts`),
  not the Claude Agent SDK. The note above still stands in general, but it
  does not apply here: the SDK's file tools run in the host process, and these
  tools have to run inside the sandbox. The loop is shared with PROT-07, so
  the harness is written once rather than twice.
- **No durable workflow.** Temporal and Inngest are both a deployment this MVP
  does not have. The acceptance criterion offers "resumes or cleanly fails";
  this does the second, explicitly. Runs are journalled to `agent_run`, and a
  startup hook fails everything still marked live and parks its card with a
  reason (`src/lib/agents/recovery.ts`). No sandbox outlives its TTL whether
  or not the process comes back, so nothing is orphaned either way.
- File scope is enforced twice: the workspace handed to the agent rejects
  out-of-scope writes as they happen, and the whole diff is re-checked before
  the commit, because an agent with a shell can go around the first one.
- Concurrency is gated at the drag, not in the agent: a ticket cannot enter
  In Progress while another *running* ticket's scope overlaps it. A ticket in
  review does not count — it holds a pull request, not a checkout.
