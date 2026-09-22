import "server-only";

import { agents } from "@/lib/agents/registry";
import { launch, startRun } from "@/lib/agents/pipeline";
import type { FailingCheck } from "@/lib/agents/ports";
import { DEFAULT_RUN_BUDGET } from "@/lib/budget/limits";
import { commitAndPush, openCheckout } from "@/lib/coder/checkout";
import { stallTicket, taskFor } from "@/lib/coder/pipeline";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { prdSchema } from "@/lib/domain/entities";
import { violationsInDiff } from "@/lib/domain/scope";
import { publish } from "@/lib/events/bus";
import { type CheckSummary, mergeNeedsPromotion, vcs } from "@/lib/vcs";
import { inMergeLane, inTicketLane } from "./lane";

/**
 * PROT-07. CI results drive a fix-or-merge loop.
 *
 * Every path out of here is terminal or waiting on a named event. A card that
 * is neither merged, nor being fixed, nor waiting for a check, is parked with
 * a reason on it — "still going" is not a state this system is allowed to sit
 * in indefinitely.
 */

const STAGE_MERGE = 7;
const STAGE_SHOWCASE = 8;

/** After this many fix attempts the card stops and waits for a human. */
export const MAX_FIX_ATTEMPTS = DEFAULT_RUN_BUDGET.maxAttempts;

/** A green-enough result. Skipped and neutral checks block nothing. */
const GREEN = ["success", "neutral", "skipped"];

/**
 * A cancelled or stale check is not a failing test — nothing ran. Spending a
 * fix attempt on one is how a queue full of superseded jobs turns into a bill,
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
 * about a commit the fix loop has already replaced is not history worth
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

  const project = await repo.defaultProject();
  const client = vcs(project.repoFullName);

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

  if (red.length === 0) {
    await publish(projectId, {
      type: "ci.status",
      ticketId: ticket.id,
      prNumber,
      state: "passing",
      checkName: null,
    });
    await inMergeLane(projectId, () => mergeTicket(projectId, ticket, prNumber));
    return;
  }

  await publish(projectId, {
    type: "ci.status",
    ticketId: ticket.id,
    prNumber,
    state: "failing",
    checkName: red[0]!.name,
  });
  await fixTicket(projectId, ticket, prNumber, red);
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
  const project = await repo.defaultProject();
  const client = vcs(project.repoFullName);

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
  const run = startRun(projectId, "pm", { epicId });

  launch(async () => {
    const outcome = await agents().showcase.summarize(run.ctx, {
      epicId,
      title: detail.title,
      prd: prd.success ? prd.data : null,
      ticketSummaries: siblings.map((t) => ({
        key: t.key,
        title: t.title,
        summary: t.summary ?? t.description.split("\n")[0] ?? t.title,
      })),
    });

    if (outcome.ok) {
      await repo.setEpicShowcase(epicId, outcome.value);
      await publish(projectId, {
        type: "card.status",
        cardId: epicId,
        kind: "epic",
        status: "merged",
        stalledIn: null,
        stage: STAGE_SHOWCASE,
        blockedReason: null,
      });
    }

    await run.finish(outcome);
  }, `showcase for epic ${epicId}`);
}

/**
 * The fix loop, under a hard ceiling. An agent iterating on a failing test is
 * the most expensive failure mode in this system, so the attempt counter is
 * persisted on the ticket rather than held in memory where a restart would
 * reset it to zero.
 */
async function fixTicket(
  projectId: string,
  ticket: TicketDetail,
  prNumber: number,
  red: CheckSummary[],
): Promise<void> {
  const repo = repository();
  const attempt = ticket.attempts + 1;
  const names = red.map((c) => c.name).join(", ");

  if (attempt > MAX_FIX_ATTEMPTS) {
    await stallTicket(
      projectId,
      ticket,
      `${names} is still failing after ${MAX_FIX_ATTEMPTS} attempts. This needs a human.`,
      { blocked: true, stalledIn: "in_review" },
    );
    return;
  }

  if (!ticket.branchName) {
    await stallTicket(
      projectId,
      ticket,
      `${ticket.key} has no branch recorded, so its pull request cannot be fixed automatically.`,
      { blocked: true, stalledIn: "in_review" },
    );
    return;
  }

  const project = await repo.defaultProject();
  const client = vcs(project.repoFullName);
  await repo.updateTicket(ticket.id, { attempts: attempt });

  const logs: FailingCheck[] = [];
  for (const check of red) {
    const log = await client.checkLog(check.id).catch(() => null);
    logs.push(
      log ?? { name: check.name, summary: "No log was available.", annotations: [] },
    );
  }

  const run = startRun(projectId, "reviewer", {
    epicId: ticket.epicId,
    ticketId: ticket.id,
  });

  const checkout = await openCheckout({
    projectId,
    repoFullName: project.repoFullName,
    fromBranch: ticket.branchName,
    newBranch: null,
    ticket,
    ctx: run.ctx,
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
    const outcome = await agents().reviewer.fix(run.ctx, {
      task: taskFor(ticket),
      workspace: checkout.workspace,
      checks: logs,
      attempt,
      maxAttempts: MAX_FIX_ATTEMPTS,
    });

    if (!outcome.ok) {
      await stallTicket(projectId, ticket, outcome.error, {
        blocked: outcome.blocked,
        stalledIn: "in_review",
      });
      await run.finish(outcome);
      return;
    }

    const changed = await checkout.raw.changedFiles();
    if (changed.length === 0) {
      const reason = `${names} is failing and the agent had no fix to offer.`;
      await stallTicket(projectId, ticket, reason, {
        blocked: true,
        stalledIn: "in_review",
      });
      await run.finish({ ...outcome, ok: false, error: reason, blocked: true });
      return;
    }

    const violations = violationsInDiff(changed, ticket.fileScope);
    if (violations.length > 0) {
      const reason =
        `The fix touched ${violations.slice(0, 5).join(", ")}, outside ${ticket.key}'s ` +
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
      subject: `${ticket.key}: ${outcome.value.summary}`,
      body: `${outcome.value.detail}\n\nFix attempt ${attempt} of ${MAX_FIX_ATTEMPTS} for ${names}.`,
    });

    if (!pushed.ok) {
      await stallTicket(projectId, ticket, pushed.reason, {
        blocked: false,
        stalledIn: "in_review",
      });
      await run.finish({ ...outcome, ok: false, error: pushed.reason, blocked: false });
      return;
    }

    await repo.updateTicket(ticket.id, {
      costCents: outcome.usage.costCents,
      tokensIn: outcome.usage.tokensIn,
      tokensOut: outcome.usage.tokensOut,
    });
    await publish(projectId, {
      type: "ci.status",
      ticketId: ticket.id,
      prNumber,
      state: "pending",
      checkName: null,
    });

    await run.finish(outcome);
  } finally {
    await checkout.dispose();
  }
}
