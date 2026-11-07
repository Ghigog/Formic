import "server-only";

import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import type { BoardCard } from "@/lib/domain/entities";
import { readiness } from "@/lib/domain/stack";
import { publish } from "@/lib/events/bus";
import type { VcsClient } from "@/lib/vcs";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { openCheckout, rebaseOntoTarget } from "./checkout";

/**
 * Stacked pull requests, as the pipelines see them. The rules are in
 * src/lib/domain/stack.ts; this is where a stacked ticket starts, where its
 * pull request points, and how it is moved onto the merge target once the
 * one under it merges.
 */

/** The prerequisite a ticket starting now builds on, or null to start from the merge target. */
export async function stackBase(
  projectId: string,
  ticket: TicketDetail,
): Promise<{ key: string; branch: string } | null> {
  const repo = repository();
  const cards = await repo.boardCards(projectId);
  const card = cards.find((c) => c.id === ticket.id);
  if (!card) return null;
  const ready = readiness(card, cards);
  // Not ready is the move's to refuse (see whatIsWrong); a run started anyway
  // starts from the merge target, exactly as before stacking existed.
  if (!ready.ready || !ready.onto) return null;
  const below = await repo.ticketDetail(ready.onto.id);
  if (!below?.branchName) return null;
  return { key: below.key, branch: below.branchName };
}

/** Tells the ticket's chat what it is stacked on, and what that means. */
export async function announceStack(projectId: string, ticket: TicketDetail, below: { key: string }, target: string) {
  const text =
    `${below.key}'s pull request is still open, so ${ticket.key} builds on it: it starts from ${below.key}'s branch, ` +
    `and its pull request targets that branch, showing only ${ticket.key}'s own change. Once ${below.key} merges, it is pointed at ${target} and merges after it.`;
  await repository().addCardChatMessage({ projectId, cardKind: "ticket", cardId: ticket.id, role: "assistant", content: text });
  await publish(projectId, { type: "ticket.reply", ticketId: ticket.id, agent: "Coder Agent", text });
}

/** The prerequisite whose branch a stacked ticket is built on, if it still has that branch. */
export async function ticketBelow(ticket: TicketDetail): Promise<TicketDetail | null> {
  if (!ticket.stackedOn) return null;
  const repo = repository();
  const card = await repo.cardById(ticket.id);
  for (const id of card?.dependsOn ?? []) {
    const dep = await repo.ticketDetail(id);
    if (dep?.branchName === ticket.stackedOn) return dep;
  }
  return null;
}

/**
 * The one under it merged: a stacked pull request is pointed at the merge
 * target and brought up to date with it. What the one under it carried is
 * on the target now, so its diff goes back to being only its own work, and
 * from here it goes through review, CI and the merge queue like any other.
 *
 * The ticket's branch is rebuilt first: its own commits are replayed onto
 * the target, cut at the head the branch below had when it merged, so the
 * squash-merged copy of that work does not come back as a conflict. When
 * that cannot be done (no checkout, or the ticket's own commits conflict
 * with the target) the target is merged in instead, and a conflict there
 * is the Reviewer Agent's, as for any other pull request.
 */
export async function restack(
  projectId: string,
  ticket: TicketDetail,
  client: VcsClient,
  target: string,
  below: { key: string; prNumber: number | null },
): Promise<void> {
  if (!ticket.prNumber) return;
  const rebuilt = await rebuildOnTarget(projectId, ticket, client, target, below).catch(() => false);
  await client.retargetPullRequest(ticket.prNumber, target);
  await repository().updateTicket(ticket.id, { stackedOn: null });
  if (!rebuilt) await client.updateBranch(ticket.prNumber).catch(() => undefined);
  await client
    .comment(
      ticket.prNumber,
      rebuilt
        ? `${below.key} merged, so this branch now holds only ${ticket.key}'s own commits on top of \`${target}\`, and its pull request targets \`${target}\`.`
        : `${below.key} merged, so this pull request now targets \`${target}\`, and \`${target}\` has been brought in.`,
    )
    .catch(() => undefined);
}

/** Rebases the ticket's own commits onto the target; false when that was not possible. */
async function rebuildOnTarget(
  projectId: string,
  ticket: TicketDetail,
  client: VcsClient,
  target: string,
  below: { prNumber: number | null },
): Promise<boolean> {
  if (!ticket.branchName || !below.prNumber) return false;
  // The merged pull request still names the head the branch below ended on,
  // which is where this ticket's own commits begin.
  const cut = (await client.pullRequest(below.prNumber)).headSha;
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const abort = new AbortController();
  const checkout = await openCheckout({
    projectId,
    repoFullName: project.repoFullName,
    fromBranch: ticket.branchName,
    newBranch: null,
    ticket,
    ctx: { runId: `restack-${ticket.id}`, projectId, emit: () => undefined, signal: abort.signal },
    repoToken: creds.repoToken,
    e2bKey: creds.e2bKey,
    e2bFallbackUserId: creds.e2bFallbackUserId,
  });
  try {
    // A mock checkout has no git to rebase.
    if (checkout.sandboxId === null) return false;
    return (await rebaseOntoTarget(checkout, { branch: ticket.branchName, target, cut })).ok;
  } finally {
    await checkout.dispose();
  }
}

/** Restacks every ticket built on `merged`'s branch that has its pull request open. */
export async function restackOnto(
  projectId: string,
  merged: TicketDetail,
  client: VcsClient,
  target: string,
): Promise<TicketDetail[]> {
  if (!merged.branchName) return [];
  const repo = repository();
  const moved: TicketDetail[] = [];
  for (const card of await repo.boardCards(projectId)) {
    if (card.kind !== "ticket" || !card.dependsOn.includes(merged.id) || !card.prNumber) continue;
    const ticket = await repo.ticketDetail(card.id);
    if (!ticket || ticket.stackedOn !== merged.branchName || ticket.status === "merged") continue;
    await restack(projectId, ticket, client, target, merged);
    moved.push(ticket);
  }
  return moved;
}

/**
 * Moves every waiting ticket whose prerequisites now let it start to ready:
 * all merged, or all but one, which has its pull request open to build on.
 * Without this they sit in To Do as `waiting` until someone drags them,
 * which makes the dependency graph decorative.
 */
export async function releaseWaiting(projectId: string, cards?: BoardCard[]): Promise<void> {
  const repo = repository();
  const all = cards ?? (await repo.boardCards(projectId));
  for (const card of all) {
    if (card.kind !== "ticket" || card.status !== "waiting") continue;
    if (!readiness(card, all).ready) continue;

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
