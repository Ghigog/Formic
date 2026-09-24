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

/** After this many reviews the card stops and waits for a human. */
export const MAX_REVIEWS = DEFAULT_RUN_BUDGET.maxAttempts;

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

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  const pull = await client.pullRequest(prNumber);
  if (pull.merged || pull.state === "closed") return;
  if (pull.headSha !== headSha) return;

  const checks = await client.checksFor(headSha);

  if (checks.length === 0 || pending(checks).length > 0) {
    await publish(projectId, {
      type: "ci.status",
      ticketId: ticket.id,
      prNumber,
      state: "pending",
      checkName: pending(checks)[0]?.name ?? null,
    });
    return;
  }

  const red = failing(checks);
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

  if (red.length === 0 && ticket.reviewedSha === headSha) {
    await inMergeLane(projectId, () => mergeTicket(projectId, ticket, prNumber));
    return;
  }

  await reviewTicket(projectId, ticket, pull, red);
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
  await maybeShowcase(projectId, ticket.epicId);
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
  const repo = repository();
  const summary = `Already done: ${evidence.summary}`.slice(0, 200);

  await repo.updateTicket(ticket.id, {
    status: "merged",
    stalledIn: null,
    stage: STAGE_MERGE,
    blockedReason: null,
    runnerJob: null,
    summary,
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

  // The evidence is the record of why nothing changed; it goes on the
  // ticket's own issue, which the move to Done closes.
  if (ticket.issueNumber && evidence.detail.trim()) {
    const project = await projectFor(projectId);
    const creds = await credentialsForProject(project);
    await vcs(project.repoFullName, creds.githubToken)
      .comment(
        ticket.issueNumber,
        `**Already done.** The Coder Agent found this in place and changed nothing.\n\n${evidence.detail.trim()}`,
      )
      .catch((e) => console.warn("[formic] could not note an already-done ticket:", e));
  }

  await releaseDependents(projectId, ticket);
  await maybeShowcase(projectId, ticket.epicId);
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
): Promise<void> {
  const repo = repository();
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  const update = await client.updateBranch(prNumber);
  if (!update.ok && update.conflict) {
    await stallTicket(
      projectId,
      ticket,
      `${ticket.key} conflicts with its base branch and needs a human to resolve it.`,
      { blocked: true, stalledIn: "in_review" },
    );
    return;
  }

  // Re-read: bringing the base branch in moves the head, and merging a sha
  // that no longer exists is how a serialized lane quietly stops being one.
  const pull = await client.pullRequest(prNumber);
  if (pull.merged) return;

  const merged = await client.merge(prNumber, pull.headSha);
  if (!merged.ok) {
    await stallTicket(
      projectId,
      ticket,
      merged.conflict
        ? `${ticket.key} could not be merged cleanly: ${merged.reason}`
        : `GitHub refused the merge: ${merged.reason}`,
      { blocked: true, stalledIn: "in_review" },
    );
    return;
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
  await maybeShowcase(projectId, ticket.epicId);
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

/** PROT-08. The Epic's showcase, once every ticket under it has merged. */
async function maybeShowcase(projectId: string, epicId: string): Promise<void> {
  const repo = repository();
  const siblings = await repo.ticketsForEpic(epicId);
  if (siblings.length === 0) return;
  if (!siblings.every((t) => t.status === "merged")) return;

  const detail = await repo.epicDetail(epicId);
  if (!detail) return;

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
  await repository().updateTicket(ticket.id, { reviewedSha: null });
  launch(() => runCoderAgent(projectId, ticket.id), `coder agent for ${ticket.key}, sent back`);
}

/** Steps outside the repository, from every run of the ticket, once each. */
function mergeHandoff(had: string[], more: string[] = []): string[] {
  return [...new Set([...had, ...more])];
}
