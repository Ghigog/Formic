# PROT-07 — Webhook and "Reviewer Agent"

**Depends on:** PROT-06
**Size:** XL
**Owns stage:** 7 — Rebase & Merge

## Goal

CI results on an agent-authored PR drive an autonomous fix-or-merge loop.

## Update: a review on every pull request

The fix loop is now a review. Once CI finishes on a head, the Reviewer Agent
reads the diff against the ticket's acceptance criteria and does one of three
things: approves it (green CI on exactly that commit merges), fixes it and
pushes (green CI on its own fix merges without another review), or sends the
ticket back to the Coder Agent with a reason, which goes on the ticket as a
note. Red CI is never approved. Reviews share the attempt ceiling, so a ticket
cannot go round between the two agents forever; a person moving the card
resets it.

Steps a ticket needs outside the repository (a secret in a service, a command
on the person's machine) are listed by the agent as "For you" steps. They go on
the ticket and its pull request, and the Epic's showcase opens with them.

## Scope

- GitHub webhook receiver with signature verification and idempotent handling
  of redelivered events.
- On CI failure: feed logs to the agent, produce a fix commit, push, wait for
  the next run.
- On CI pass: rebase against the base branch, resolve conflicts, merge.
- Serialized merge lane — exactly one merge in flight at a time, per the MVP's
  sequential merging constraint.
- Ticket moves to Done on merge; failure states surface on the card with the
  failing check named.
- Bounded attempts, then the card is parked in a blocked state for a human.

## Out of scope

- Showcase generation (PROT-08).

## Acceptance criteria

- A PR with a deliberately failing test gets a fix commit and reaches green.
- Two PRs ready at once merge one after the other, each rebased on the result
  of the previous.
- A replayed webhook does not trigger a second fix commit.
- After N failed attempts the card stops and says why, rather than looping.

## Notes and risks

- **This is the riskiest ticket in the set and it needs a decision before it is
  built: does anything merge to the default branch without a human?** The PRD
  says yes. That is defensible on a throwaway boilerplate repo and is not
  defensible on anything with users. Recommendation for the MVP: merge
  autonomously only into a `formic/integration` branch, and require one human
  click to promote to `main`. It costs one button and removes the entire class
  of "the colony merged something bad at 3am".
- Conflict resolution by agent is a genuinely hard problem wearing a small
  ticket's clothing. For the MVP, on any conflict the agent cannot resolve
  cleanly, park the card as blocked. Do not let it force-push its way out.
- Webhooks are at-least-once and out of order. Idempotency keyed on
  `(pr, head_sha, check_name)` is not optional.
- A fix loop that responds to its own pushes is the obvious runaway. Gate on
  commit authorship and an attempt counter stored on the ticket.

## As built

**The decision the ticket asked for: nothing reaches the base branch
unattended.** Agents merge into `formic/integration`, created from the base
branch on first use, and promoting it is a human's click. `MERGE_TARGET=base`
restores the PRD's behaviour, in one place, as a deliberate choice.

- Conflicts are never forced. The branch is brought up to date with a merge,
  never a rebase or a force-push. When that conflicts, the In Review agent
  resolves it: the base is merged into the branch with its conflicts left
  in, the agent resolves them, and the result is pushed as a merge commit
  (in a sandbox, or in GitHub Actions for a CLI agent, where Formic records
  the merge itself). A resolution that leaves markers, strays outside the
  ticket's scope beyond what the base brought, or keeps coming back past the
  review ceiling parks the card as blocked.
- Idempotency is keyed on `(pull request, head sha, check)` rather than the
  delivery id, so a redelivery under a new id is still the same result. A
  result about a commit that is no longer the head is dropped, which is what
  makes out-of-order deliveries harmless.
- The runaway gate is threefold: agent commits carry a fixed authorship, the
  attempt counter is persisted on the ticket so a restart cannot reset it, and
  reactions are serialized per ticket so a commit finishing four checks does
  not open four sandboxes.
- After the ceiling the card is parked in `blocked` with the failing check
  named, in the column it stalled in.
