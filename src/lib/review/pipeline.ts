import "server-only";

import { applyShowcase, launch, startRun } from "@/lib/agents/pipeline";
import type { FailingCheck } from "@/lib/agents/ports";
import { DEFAULT_RUN_BUDGET } from "@/lib/budget/limits";
import { commitAndPush, openCheckout } from "@/lib/coder/checkout";
import { runCoderAgent, stallTicket, taskFor } from "@/lib/coder/pipeline";
import { repository } from "@/lib/db";
import { projectFor } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";
import type { TicketDetail } from "@/lib/db/repository";
import { prdSchema } from "@/lib/domain/entities";
import { violationsInDiff } from "@/lib/domain/scope";
import { publish } from "@/lib/events/bus";
import { positionForIndex } from "@/lib/ordering";
import { type CheckSummary, type PullRequestDetail, mergeNeedsPromotion, vcs } from "@/lib/vcs";
import { inMergeLane, inTicketLane } from "./lane";
import { addNote, noteTexts } from "@/lib/coder/notes";
import { agentFor, cliAgentFor, modelFor } from "@/lib/agents/presets";
import { cliPrompt, showcaseSummaries, startCliAnswer, startCliRun } from "@/lib/runner/runner";

/**
 * PROT-07. Every pull request is reviewed before it merges.
 *
 * Once CI has finished on a head, the Reviewer Agent reads the diff against
 * the ticket's acceptance criteria and approves it, fixes it, or sends the
 * ticket back to the Coder Agent with a reason. Red CI is one more thing it
 * deals with: it is never approved. Only green CI on the exact commit the
 * reviewer approved or pushed merges.
 *
 * Every path out of here is terminal or waiting on a named event. A card that
 * is neither merged, nor being reviewed, nor waiting for a check, is parked
 * with a reason on it — "still going" is not a state this system is allowed
 * to sit in indefinitely.
 */

const STAGE_MERGE = 7;

/**
 * After this many reviews the card stops and waits for a human. One more
 * than the attempt budget: the review that reads the diff alongside CI
 * should not cost a fix attempt when CI then comes back red.
 */
export const MAX_REVIEWS = DEFAULT_RUN_BUDGET.maxAttempts + 1;

/** A green-enough result. Skipped and neutral checks block nothing. */
const GREEN = ["success", "neutral", "skipped"];

/**
 * A cancelled or stale check is not a failing test — nothing ran. Spending a
 * review on one is how a queue full of superseded jobs turns into a bill,
 * so they count as unresolved and the card waits for a real result.
 */
const NOT_A_RESULT = ["cancelled", "stale"];

function failing(checks: CheckSummary[]): CheckSummary[] {
  return checks.filter(
    (c) =>
      c.status === "completed" &&
      c.conclusion !== null &&
      !GREEN.includes(c.conclusion) &&
      !NOT_A_RESULT.includes(c.conclusion),
  );
}

function pending(checks: CheckSummary[]): CheckSummary[] {
  return checks.filter(
    (c) =>
      c.status !== "completed" ||
      (c.conclusion !== null && NOT_A_RESULT.includes(c.conclusion)),
  );
}

/**
 * The entry point every CI signal funnels into. Idempotency is the caller's
 * (see ./deliveries.ts): by the time this runs, the event is known to be new.
 */
export async function reviewPullRequest(
  projectId: string,
  prNumber: number,
  headSha: string,
): Promise<void> {
  const repo = repository();
  const ticket = await repo.ticketByPrNumber(projectId, prNumber);

  // A pull request Formic did not open. Not an error: the webhook is
  // repository-wide and humans open pull requests too.
  if (!ticket) return;
  if (ticket.status === "merged") return;

  await inTicketLane(ticket.id, () => react(projectId, ticket.id, prNumber, headSha));
}

/**
 * One reaction per ticket at a time, and only to the commit that is currently
 * at the head. Webhooks arrive at least once and out of order, so an event
 * about a commit the reviewer has already replaced is not history worth
 * repeating.
 */
async function react(
  projectId: string,
  ticketId: string,
  prNumber: number,
  headSha: string,
): Promise<void> {
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket || ticket.status === "merged") return;
  // Sent back: the Coder Agent has it, and its push is what gets reviewed.
  if (ticket.status === "running") return;

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  const pull = await client.pullRequest(prNumber);
  if (pull.merged) return;
  const stuck = ticket.runnerJob ? null : whyStuck(ticket.key, pull);
  if (stuck) {
    await stallTicket(projectId, ticket, stuck, { blocked: true, stalledIn: "in_review" });
    return;
  }
  if (pull.merged || pull.state === "closed") return;
  if (pull.headSha !== headSha) return;

  // Bringing the base in moves the head without changing the work, so the
  // approval of the head it was made on still stands. CI on the new head
  // decides the merge, rather than a second review of the same change.
  let reviewedSha = ticket.reviewedSha;
  if (
    reviewedSha &&
    reviewedSha !== headSha &&
    (await client.bringsInBase(reviewedSha, headSha, pull.baseBranch))
  ) {
    reviewedSha = headSha;
    await repo.updateTicket(ticket.id, { reviewedSha });
  }

  const checks = await client.checksFor(headSha);
  const red = failing(checks);

  if (checks.length === 0 || pending(checks).length > 0) {
    await publish(projectId, {
      type: "ci.status",
      ticketId: ticket.id,
      prNumber,
      state: "pending",
      checkName: pending(checks)[0]?.name ?? null,
    });
    // The review reads the diff while CI runs, rather than after it, and
    // the merge waits for both. Once it has approved this head, or once a
    // check has already failed, the rest of CI is worth waiting for.
    if (ticket.runnerJob || reviewedSha === headSha || red.length > 0) return;
    await reviewTicket(projectId, ticket, pull, [], { ciRunning: true });
    return;
  }

  await publish(projectId, {
    type: "ci.status",
    ticketId: ticket.id,
    prNumber,
    state: red.length === 0 ? "passing" : "failing",
    checkName: red[0]?.name ?? null,
  });

  // A reviewer is already on this pull request in GitHub Actions. More
  // reports about the same head are not a reason to start another.
  if (ticket.runnerJob) return;

  if (red.length === 0 && reviewedSha === headSha) {
    await inMergeLane(projectId, () => mergeTicket(projectId, ticket, prNumber));
    return;
  }

  await reviewTicket(projectId, ticket, pull, red);
}

/**
 * Why a pull request can never move on by itself, or null when it can. A
 * conflicted one gets no CI, because GitHub cannot build its merge; a closed
 * one gets nothing at all. Either would leave the card waiting forever for a
 * webhook that is not coming.
 */
function whyStuck(key: string, pull: PullRequestDetail): string | null {
  if (pull.state === "closed") {
    return `${key}'s pull request #${pull.number} was closed without merging. Move ${key} to To Do, then In Progress, to start it over on the current code.`;
  }
  if (pull.mergeable === false) {
    return `${key}'s pull request #${pull.number} conflicts with ${pull.baseBranch}, so CI cannot run on it. Resolve the conflict on GitHub and it carries on once CI passes, or close the pull request and move ${key} to To Do, then In Progress, to redo it on the current code.`;
  }
  return null;
}

/** When each board's open pull requests were last looked at, to go easy on the API. */
const lastSwept = new Map<string, number>();
const SWEEP_EVERY_MS = 30_000;

/**
 * Looks at every pull request the board is waiting on in In Review. Nothing
 * else notices one that conflicted or was closed, since neither sends the CI
 * webhook the reviewer waits for; this parks it with a reason instead.
 */
export async function sweepOpenPullRequests(projectId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastSwept.get(projectId) ?? 0) < SWEEP_EVERY_MS) return;
  lastSwept.set(projectId, now);

  const repo = repository();
  const cards = await repo.boardCards(projectId);

  // An Epic whose tickets all merged before Epics completed themselves.
  for (const epic of cards) {
    if (epic.kind !== "epic" || epic.status === "merged") continue;
    if (epic.childCount > 0 && epic.doneCount === epic.childCount) {
      await completeEpic(projectId, epic.id);
    }
  }

  const waiting = cards.filter(
    (c) => c.kind === "ticket" && c.status === "review" && c.prNumber,
  );
  if (waiting.length === 0) return;

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  for (const card of waiting) {
    const ticket = await repo.ticketDetail(card.id);
    // A reviewer at work in GitHub Actions reports back on its own.
    if (!ticket?.prNumber || ticket.status !== "review" || ticket.runnerJob) continue;
    const pull = await client.pullRequest(ticket.prNumber).catch(() => null);
    if (!pull) continue;
    if (pull.merged) {
      await markMergedExternally(projectId, pull.number);
      continue;
    }
    const stuck = whyStuck(ticket.key, pull);
    if (stuck) await stallTicket(projectId, ticket, stuck, { blocked: true, stalledIn: "in_review" });
  }
}

/** Test seam. */
export function resetPullRequestSweep(): void {
  lastSwept.clear();
}

/**
 * A human merged it. The card follows reality rather than waiting for a merge
 * the platform is no longer going to perform.
 */
export async function markMergedExternally(
  projectId: string,
  prNumber: number,
): Promise<void> {
  const repo = repository();
  const ticket = await repo.ticketByPrNumber(projectId, prNumber);
  if (!ticket || ticket.status === "merged") return;

  await repo.updateTicket(ticket.id, {
    status: "merged",
    stalledIn: null,
    stage: STAGE_MERGE,
    blockedReason: null,
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "merged",
    stalledIn: null,
    stage: STAGE_MERGE,
    blockedReason: null,
  });

  await releaseDependents(projectId, ticket);
  await completeEpic(projectId, ticket.epicId);
}

/**
 * The coding agent found the ticket's work already in the repository and
 * changed nothing. There is nothing to review or merge, so the ticket goes
 * straight to Done with the agent's evidence as its summary, and whatever
 * was waiting on it is released exactly as a merge would release it.
 */
export async function closeAlreadyDone(
  projectId: string,
  ticket: TicketDetail,
  evidence: { summary: string; detail: string },
): Promise<void> {
  await closeWithoutMerge(projectId, ticket, {
    summary: `Already done: ${evidence.summary}`,
    comment: evidence.detail.trim()
      ? `**Already done.** The Coder Agent found this in place and changed nothing.\n\n${evidence.detail.trim()}`
      : null,
  });
}

/**
 * A person says the ticket is done, and nothing is left to merge: work a
 * person did themselves, or work that turned out not to be needed. It goes
 * to Done like a merge, with what they said as its summary.
 */
export async function closeByPerson(projectId: string, ticket: TicketDetail, summary: string): Promise<void> {
  await closeWithoutMerge(projectId, ticket, {
    summary: `Closed by you: ${summary}`,
    comment: `**Closed from Formic.** ${summary}`,
  });
}

async function closeWithoutMerge(
  projectId: string,
  ticket: TicketDetail,
  input: { summary: string; comment: string | null },
): Promise<void> {
  const repo = repository();
  await repo.updateTicket(ticket.id, {
    status: "merged",
    stalledIn: null,
    stage: STAGE_MERGE,
    blockedReason: null,
    runnerJob: null,
    runnerAgent: null,
    needsHuman: null,
    summary: input.summary.slice(0, 200),
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "merged",
    stalledIn: null,
    stage: STAGE_MERGE,
    blockedReason: null,
  });

  // The record of why nothing merged goes on the ticket's own issue, which
  // the move to Done closes.
  if (ticket.issueNumber && input.comment) {
    const project = await projectFor(projectId);
    const creds = await credentialsForProject(project);
    await vcs(project.repoFullName, creds.githubToken)
      .comment(ticket.issueNumber, input.comment)
      .catch((e) => console.warn("[formic] could not note a closed ticket:", e));
  }

  await releaseDependents(projectId, ticket);
  await completeEpic(projectId, ticket.epicId);
}

type MergeResult = { merged: true } | { merged: false; reason: string };

/**
 * A person asks for the ticket's pull request to merge, in its chat. Their
 * word stands in for the review, but red CI still does not merge, and a
 * merge GitHub refuses leaves the ticket in In Review saying why. It never
 * reaches Done without the merge. Returns what happened, in a line.
 */
export async function mergeByPerson(
  projectId: string,
  ticket: TicketDetail,
  prNumber: number,
): Promise<string> {
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  const pull = await client.pullRequest(prNumber);
  if (pull.merged) {
    await markMergedExternally(projectId, prNumber);
    return `Pull request #${prNumber} has already merged; ${ticket.key} is in Done.`;
  }
  if (pull.state === "closed") {
    return `Pull request #${prNumber} is closed on GitHub, so there is nothing to merge. Reopen it there, or close ${ticket.key} if the work is not needed.`;
  }
  const checks = await client.checksFor(pull.headSha);
  const red = failing(checks);
  if (red.length > 0) {
    return `${red.map((c) => c.name).join(", ")} is failing on pull request #${prNumber}. Red CI does not merge.`;
  }
  if (checks.length === 0 || pending(checks).length > 0) {
    return `CI is still running on pull request #${prNumber}. Ask again once it passes.`;
  }

  // The person vouches for this head, so bringing the base in carries it
  // across exactly as a review's approval would.
  await repository().updateTicket(ticket.id, { reviewedSha: pull.headSha });
  const result = await inMergeLane(projectId, async () => {
    const fresh = (await repository().ticketDetail(ticket.id)) ?? ticket;
    return mergeTicket(projectId, fresh, prNumber);
  });
  if (!result.merged) return `Did not merge pull request #${prNumber}: ${result.reason}`;
  // Merged already, or just now by the lane: either way the card says so.
  await markMergedExternally(projectId, prNumber);
  return `Merged pull request #${prNumber}; ${ticket.key} is in Done, and anything waiting on it can go ahead.`;
}

/**
 * One merge at a time, each rebased on the result of the last. Conflicts the
 * agent cannot resolve cleanly park the card rather than being forced
 * through; see the risk note in docs/tasks/PROT-07-reviewer-agent.md.
 */
async function mergeTicket(
  projectId: string,
  ticket: TicketDetail,
  prNumber: number,
): Promise<MergeResult> {
  const repo = repository();
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  const before = await client.pullRequest(prNumber);
  if (before.merged) return { merged: true };

  const update = await client.updateBranch(prNumber);
  if (!update.ok && update.conflict) {
    await stallTicket(
      projectId,
      ticket,
      `${ticket.key} conflicts with its base branch and needs a human to resolve it.`,
      { blocked: true, stalledIn: "in_review" },
    );
    return { merged: false, reason: `${ticket.key} conflicts with its base branch and needs a human to resolve it.` };
  }

  // GitHub brings the base in after it answers, so the new head, its
  // mergeability and its CI all arrive later. Merging straight away races
  // that and GitHub refuses with "not mergeable". Once the head has moved,
  // CI on it merges it, under the approval react() carries across.
  if (update.ok && update.updated) {
    const moved = await settle(client, prNumber, (p) => p.headSha !== before.headSha);
    if (moved) {
      return { merged: false, reason: `Brought ${before.baseBranch} into it first; it merges once CI passes on the new head.` };
    }
  }

  // Re-read: merging a sha that no longer exists is how a serialized lane
  // quietly stops being one. GitHub works out mergeability lazily, and a
  // merge asked for while it is still null is refused.
  const pull =
    (await settle(client, prNumber, (p) => p.mergeable !== null)) ??
    (await client.pullRequest(prNumber));
  if (pull.merged) return { merged: true };

  const merged = await client.merge(prNumber, pull.headSha);
  if (!merged.ok) {
    // A 405 means a conflict only when GitHub says so; otherwise it is a
    // refusal worth reporting as what it was.
    const after = await client.pullRequest(prNumber).catch(() => null);
    const conflict = merged.conflict && after?.mergeable === false;
    const reason = conflict
      ? `${ticket.key} could not be merged cleanly: ${merged.reason}`
      : `GitHub refused the merge: ${merged.reason}`;
    await stallTicket(projectId, ticket, reason, { blocked: true, stalledIn: "in_review" });
    return { merged: false, reason };
  }

  await repo.updateTicket(ticket.id, {
    status: "merged",
    stalledIn: null,
    stage: STAGE_MERGE,
    blockedReason: null,
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "merged",
    stalledIn: null,
    stage: STAGE_MERGE,
    blockedReason: null,
  });

  if (mergeNeedsPromotion(project.baseBranch)) {
    await client.comment(
      prNumber,
      `Merged into \`${pull.baseBranch}\`. Promoting to \`${project.baseBranch}\` is a human's call.`,
    );
  }

  await releaseDependents(projectId, ticket);
  await completeEpic(projectId, ticket.epicId);
  return { merged: true };
}

const SETTLE_TRIES = 10;
const SETTLE_EVERY_MS = 1_000;

/**
 * Re-reads a pull request until `ready` holds, for the few seconds GitHub
 * takes to catch up after a write. Null when it never did.
 */
async function settle(
  client: ReturnType<typeof vcs>,
  prNumber: number,
  ready: (pull: PullRequestDetail) => boolean,
): Promise<PullRequestDetail | null> {
  for (let i = 0; i < SETTLE_TRIES; i++) {
    const pull = await client.pullRequest(prNumber);
    if (pull.merged || ready(pull)) return pull;
    await new Promise((r) => setTimeout(r, SETTLE_EVERY_MS));
  }
  return null;
}

/**
 * A merge can unblock siblings. Without this they sit in To Do as `waiting`
 * until someone drags them, which makes the dependency graph decorative.
 */
async function releaseDependents(
  projectId: string,
  merged: TicketDetail,
): Promise<void> {
  const repo = repository();
  const cards = await repo.boardCards(projectId);
  const mergedIds = new Set(
    cards.filter((c) => c.status === "merged").map((c) => c.id),
  );
  mergedIds.add(merged.id);

  for (const card of cards) {
    if (card.kind !== "ticket" || card.status !== "waiting") continue;
    if (!card.dependsOn.every((id) => mergedIds.has(id))) continue;

    await repo.updateTicket(card.id, { status: "ready", stalledIn: null });
    await publish(projectId, {
      type: "card.status",
      cardId: card.id,
      kind: "ticket",
      status: "ready",
      stalledIn: null,
      stage: card.stage,
      blockedReason: null,
    });
  }
}

/**
 * PROT-08. Once every ticket under an Epic has merged, the Epic is done: it
 * moves to the top of Done on its own, and the PM Agent writes its showcase
 * if it has none yet. Saved before the showcase runs, so an Epic whose
 * showcase fails still leaves To Do.
 */
export async function completeEpic(
  projectId: string,
  epicId: string,
  position?: number,
): Promise<void> {
  const repo = repository();
  const siblings = await repo.ticketsForEpic(epicId);
  if (siblings.length === 0) return;
  if (!siblings.every((t) => t.status === "merged")) return;

  const detail = await repo.epicDetail(epicId);
  if (!detail) return;
  const card = await repo.cardById(epicId);
  if (card?.status === "merged") return;

  const done = await repo.columnPositions(projectId, "done");
  await repo.move({
    cardId: epicId,
    kind: "epic",
    status: "merged",
    stalledIn: null,
    position: position ?? positionForIndex(done, 0),
  });
  await repo.rebalanceColumn(projectId, "done");
  await publish(projectId, {
    type: "card.status",
    cardId: epicId,
    kind: "epic",
    status: "merged",
    stalledIn: null,
    stage: card?.stage ?? 8,
    blockedReason: null,
  });

  if (detail.showcase) return;

  const prd = prdSchema.safeParse(detail.prd);
  const run = startRun(projectId, "pm", {
    epicId,
    model: await modelFor(projectId, "showcase"),
  });

  launch(async () => {
    const cli = await cliAgentFor(projectId, "done");
    if (cli) {
      await startCliAnswer({ projectId, epicId, mode: "showcase", agent: cli, run });
      return;
    }

    const outcome = await (await agentFor(projectId, "showcase")).summarize(run.ctx, {
      epicId,
      title: detail.title,
      prd: prd.success ? prd.data : null,
      ticketSummaries: showcaseSummaries(siblings),
    });

    if (outcome.ok) await applyShowcase(projectId, epicId, outcome.value);

    await run.finish(outcome);
  }, `showcase for epic ${epicId}`);
}

/**
 * The review, under a hard ceiling. A ticket going round between the Coder
 * and the Reviewer, or a reviewer iterating on a failing test, is the most
 * expensive failure mode in this system, so the count is persisted on the
 * ticket rather than held in memory where a restart would reset it to zero.
 */
async function reviewTicket(
  projectId: string,
  ticket: TicketDetail,
  pull: PullRequestDetail,
  red: CheckSummary[],
  options: { ciRunning?: boolean } = {},
): Promise<void> {
  const repo = repository();
  const attempt = ticket.attempts + 1;
  const names = red.map((c) => c.name).join(", ");

  if (attempt > MAX_REVIEWS) {
    await stallTicket(
      projectId,
      ticket,
      red.length
        ? `${names} is still failing after ${MAX_REVIEWS} reviews. This needs a human.`
        : `${ticket.key} has been reviewed ${MAX_REVIEWS} times without being approved. This needs a human.`,
      { blocked: true, stalledIn: "in_review" },
    );
    return;
  }

  if (!ticket.branchName) {
    await stallTicket(
      projectId,
      ticket,
      `${ticket.key} has no branch recorded, so its pull request cannot be reviewed automatically.`,
      { blocked: true, stalledIn: "in_review" },
    );
    return;
  }

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  await repo.updateTicket(ticket.id, { attempts: attempt });

  const logs: FailingCheck[] = [];
  for (const check of red) {
    const log = await client.checkLog(check.id).catch(() => null);
    logs.push(
      log ?? { name: check.name, summary: "No log was available.", annotations: [] },
    );
  }
  const changedFiles = await client
    .compare(pull.baseBranch, ticket.branchName)
    .then((c) => c.files)
    .catch(() => []);
  const review = {
    baseBranch: pull.baseBranch,
    changedFiles,
    checks: logs,
    ciRunning: options.ciRunning ?? false,
    attempt,
    maxAttempts: MAX_REVIEWS,
  };

  const run = startRun(projectId, "reviewer", {
    model: await modelFor(projectId, "reviewer"),
    epicId: ticket.epicId,
    ticketId: ticket.id,
  });

  const cli = await cliAgentFor(projectId, "in_review");
  if (cli) {
    await startCliRun({
      projectId,
      ticket,
      mode: "fix",
      agent: cli,
      from: ticket.branchName,
      prompt: cliPrompt(cli, "fix", ticket, review, await noteTexts(projectId, ticket.id)),
      run,
      stalledIn: "in_review",
    });
    return;
  }

  const checkout = await openCheckout({
    projectId,
    repoFullName: project.repoFullName,
    fromBranch: ticket.branchName,
    newBranch: null,
    ticket,
    ctx: run.ctx,
    githubToken: creds.githubToken,
    e2bKey: creds.e2bKey,
  }).catch((e: unknown) => e as Error);

  if (checkout instanceof Error) {
    await stallTicket(projectId, ticket, `Could not open a sandbox: ${checkout.message}`, {
      blocked: false,
      stalledIn: "in_review",
    });
    await run.finish({
      ok: false,
      error: checkout.message,
      blocked: false,
      usage: { model: "none", tokensIn: 0, tokensOut: 0, costCents: 0 },
    });
    return;
  }

  if (checkout.sandboxId) await run.attachSandbox(checkout.sandboxId);

  try {
    const outcome = await (await agentFor(projectId, "reviewer")).review(run.ctx, {
      task: taskFor(ticket, await noteTexts(projectId, ticket.id)),
      workspace: checkout.workspace,
      ...review,
    });

    if (!outcome.ok) {
      await stallTicket(projectId, ticket, outcome.error, {
        blocked: outcome.blocked,
        stalledIn: "in_review",
      });
      await run.finish(outcome);
      return;
    }

    const verdict = outcome.value;
    await repo.updateTicket(ticket.id, {
      costCents: outcome.usage.costCents,
      tokensIn: outcome.usage.tokensIn,
      tokensOut: outcome.usage.tokensOut,
    });

    if (verdict.sendBack) {
      // Whatever it edited on the way to deciding this is not pushed.
      await sendBack(projectId, ticket, verdict.sendBack);
      await run.finish(outcome);
      return;
    }

    const changed = await checkout.raw.changedFiles();
    if (changed.length === 0) {
      if (red.length > 0) {
        const reason = `${names} is failing and the Reviewer Agent had no fix to offer.`;
        await stallTicket(projectId, ticket, reason, { blocked: true, stalledIn: "in_review" });
        await run.finish({ ...outcome, ok: false, error: reason, blocked: true });
        return;
      }
      await run.finish(outcome);
      await approve(projectId, ticket, pull.number, pull.headSha, verdict);
      return;
    }

    const violations = violationsInDiff(changed, ticket.fileScope);
    if (violations.length > 0) {
      const reason =
        `The review's fix touched ${violations.slice(0, 5).join(", ")}, outside ${ticket.key}'s ` +
        `file scope. Nothing was pushed.`;
      await stallTicket(projectId, ticket, reason, {
        blocked: true,
        stalledIn: "in_review",
      });
      await run.finish({ ...outcome, ok: false, error: reason, blocked: true });
      return;
    }

    const pushed = await commitAndPush(checkout, {
      branch: ticket.branchName,
      subject: `${ticket.key}: ${verdict.summary}`,
      body: `${verdict.detail}\n\nFrom review ${attempt} of ${MAX_REVIEWS}${names ? `, for ${names}` : ""}.`,
    });

    if (!pushed.ok) {
      await stallTicket(projectId, ticket, pushed.reason, {
        blocked: false,
        stalledIn: "in_review",
      });
      await run.finish({ ...outcome, ok: false, error: pushed.reason, blocked: false });
      return;
    }

    await run.finish(outcome);
    await recordFix(projectId, ticket, pull.number, pushed.sha, verdict.handoff ?? []);
  } finally {
    await checkout.dispose();
  }
}

/**
 * The reviewer approved the head it was given. Green CI on exactly that
 * commit merges it; if CI is not green on it, the approval does not count.
 */
export async function approve(
  projectId: string,
  ticket: TicketDetail,
  prNumber: number,
  headSha: string,
  verdict: { summary: string; detail: string; handoff?: string[] },
): Promise<void> {
  const repo = repository();
  await repo.updateTicket(ticket.id, {
    reviewedSha: headSha,
    handoff: mergeHandoff(ticket.handoff, verdict.handoff),
  });
  await publish(projectId, {
    type: "run.thought",
    runId: "",
    ticketId: ticket.id,
    kind: "text",
    text: `Approved: ${verdict.detail.trim() || verdict.summary}`.slice(0, 4_000),
  });

  // Re-read: a push could have landed while it reviewed, and a result could
  // have changed. The lane decides again from what is true now.
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  const pull = await client.pullRequest(prNumber);
  if (pull.merged || pull.state === "closed" || pull.headSha !== headSha) return;
  const checks = await client.checksFor(headSha);
  if (checks.length === 0 || pending(checks).length > 0) return;
  const red = failing(checks);
  if (red.length > 0) {
    await stallTicket(
      projectId,
      ticket,
      `The Reviewer Agent approved ${ticket.key}, but ${red.map((c) => c.name).join(", ")} is failing. Red CI does not merge.`,
      { blocked: true, stalledIn: "in_review" },
    );
    return;
  }
  const fresh = await repo.ticketDetail(ticket.id);
  if (!fresh || fresh.status === "merged") return;
  await inMergeLane(projectId, () => mergeTicket(projectId, fresh, prNumber));
}

/**
 * The reviewer pushed a fix. It vouches for that commit, so green CI on it
 * merges without another review; red CI on it is reviewed again.
 */
export async function recordFix(
  projectId: string,
  ticket: TicketDetail,
  prNumber: number,
  sha: string,
  handoff: string[],
): Promise<void> {
  await repository().updateTicket(ticket.id, {
    reviewedSha: sha,
    handoff: mergeHandoff(ticket.handoff, handoff),
  });
  await publish(projectId, {
    type: "ci.status",
    ticketId: ticket.id,
    prNumber,
    state: "pending",
    checkName: null,
  });

  // A mock GitHub sends no webhook for the new head, so drive the next
  // stage directly, as opening the pull request does.
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  const pull = client.name === "mock" ? await client.pullRequest(prNumber).catch(() => null) : null;
  if (pull) {
    await repository().updateTicket(ticket.id, { reviewedSha: pull.headSha });
    launch(
      () => reviewPullRequest(projectId, prNumber, pull.headSha),
      `mock review for ${ticket.key}`,
    );
  }
}

/**
 * The change misses the ticket. The reason goes on the ticket as a note,
 * which briefs every later run of it, and the Coder Agent takes it again on
 * the same pull request.
 */
export async function sendBack(
  projectId: string,
  ticket: TicketDetail,
  reason: string,
): Promise<void> {
  await addNote(projectId, ticket.id, `Sent back by review: ${reason}`);
  // Running from here, not from when the Coder Agent gets going: a CI
  // result arriving in between would otherwise review the same head again.
  await repository().updateTicket(ticket.id, { reviewedSha: null, status: "running" });
  launch(() => runCoderAgent(projectId, ticket.id), `coder agent for ${ticket.key}, sent back`);
}

/** Steps outside the repository, from every run of the ticket, once each. */
function mergeHandoff(had: string[], more: string[] = []): string[] {
  return [...new Set([...had, ...more])];
}
