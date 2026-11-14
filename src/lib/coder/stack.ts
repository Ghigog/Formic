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
): Promise<{ id: string; key: string; branch: string } | null> {
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
  return { id: below.id, key: below.key, branch: below.branchName };
}

/** Tells the ticket's chat what it is stacked on, and what that means. */
export async function announceStack(projectId: string, ticket: TicketDetail, below: { key: string }, target: string) {
  const text =
    `${below.key}'s pull request is still open, so ${ticket.key} builds on it: it starts from ${below.key}'s branch, ` +
    `and its pull request targets that branch, showing only ${ticket.key}'s own change. Once ${below.key} merges, it is pointed at ${target} and merges after it.`;
  await repository().addCardChatMessage({ projectId, cardKind: "ticket", cardId: ticket.id, role: "assistant", content: text });
  await publish(projectId, { type: "ticket.reply", ticketId: ticket.id, agent: "Coder Agent", text });
}

/**
 * Parks a ticket in the queue until the prerequisite it would build on has
 * merged: that branch conflicts with the merge target, so it cannot be
 * stacked on, and the prerequisite is likely sorting itself out in review.
 * The queue skips it until then (waitsForMerge), and the merge starts it.
 */
export async function holdForMerge(projectId: string, ticket: TicketDetail, below: { id: string; key: string }, target: string) {
  const reason = `Waits for ${below.key} to merge: its branch conflicts with ${target}. ${ticket.key} starts on its own then.`;
  await repository().updateTicket(ticket.id, { status: "queued", stalledIn: null, blockedReason: reason, waitsForMerge: below.id });
  await publish(projectId, { type: "card.status", cardId: ticket.id, kind: "ticket", status: "queued", stalledIn: null, stage: ticket.stage, blockedReason: reason });
  const text = `${below.key}'s branch conflicts with ${target}, so ${ticket.key} cannot build on it yet. It waits here and starts on its own once ${below.key} has merged.`;
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

/** Hands a pull request that conflicts to the Reviewer Agent (resolveIfStillConflicted, passed in so this file needs nothing from review). */
export type HandToReviewer = (ticketId: string, prNumber: number) => void;

/** The tickets built directly on `ticket`'s branch, whose pull requests are still open. */
async function stackedAbove(projectId: string, ticket: TicketDetail): Promise<TicketDetail[]> {
  if (!ticket.branchName) return [];
  const repo = repository();
  const above: TicketDetail[] = [];
  for (const card of await repo.boardCards(projectId)) {
    if (card.kind !== "ticket" || !card.dependsOn.includes(ticket.id) || !card.prNumber) continue;
    const found = await repo.ticketDetail(card.id);
    if (found && found.stackedOn === ticket.branchName && found.status !== "merged") above.push(found);
  }
  return above;
}

/**
 * A stacked pull request that could not be rebased is not blocked straight
 * away: it is pointed at the base it belongs on, brought up to date by the
 * platform, and what still conflicts goes to the Reviewer Agent, which blocks
 * the ticket only when it cannot resolve it. `base` is the merge target for
 * the ticket right above what merged, or the branch below it otherwise (that
 * one is still open, so the ticket stays stacked on it).
 */
export async function handOffToReviewer(
  ticket: TicketDetail,
  client: VcsClient,
  base: string,
  hand: HandToReviewer | undefined,
  options: { unstack: boolean },
): Promise<void> {
  if (!ticket.prNumber) return;
  await client.retargetPullRequest(ticket.prNumber, base);
  if (options.unstack) await repository().updateTicket(ticket.id, { stackedOn: null });
  const update = await client.updateBranch(ticket.prNumber).catch(() => null);
  if (!update?.ok) hand?.(ticket.id, ticket.prNumber);
}

type Rung = { ticket: TicketDetail; parent: TicketDetail | null };

/**
 * `below` merged: each ticket built on it moves onto the merge target (cut at
 * the head `below` ended on, so its squash-merged copy does not come back as a
 * conflict), then what is stacked on that is rebased onto its new head, and so
 * on up the stack. A ticket above keeps its stackedOn and its pull request
 * base; its cut is where its own commits begin on the old head of the branch
 * below it, read before that branch is rewritten. A review of the old head
 * stands for the new one when the change is the same change.
 *
 * A ticket that cannot be rebased goes to the Reviewer Agent; what is stacked
 * on it waits, and the rest of the stack carries on.
 */
async function restackStack(
  projectId: string,
  roots: TicketDetail[],
  below: { key: string; prNumber: number | null },
  client: VcsClient,
  target: string,
  hand: HandToReviewer | undefined,
): Promise<void> {
  const rungs: Rung[] = [];
  const collect = async (ticket: TicketDetail, parent: TicketDetail | null) => {
    rungs.push({ ticket, parent });
    for (const above of await stackedAbove(projectId, ticket)) await collect(above, ticket);
  };
  for (const root of roots) await collect(root, null);
  if (rungs.length === 0) return;

  const repo = repository();
  // The merged pull request still names the head the branch below ended on,
  // which is where the first tickets' own commits begin.
  const mergedHead = below.prNumber ? await client.pullRequest(below.prNumber).then((p) => p.headSha, () => null) : null;
  const first = rungs[0]!.ticket;
  const abort = new AbortController();
  const checkout = await (async () => {
    if (!first.branchName) return null;
    try {
      const project = await projectFor(projectId);
      const creds = await credentialsForProject(project);
      const opened = await openCheckout({
        projectId,
        repoFullName: project.repoFullName,
        fromBranch: first.branchName,
        newBranch: null,
        ticket: first,
        ctx: { runId: `restack-${first.id}`, projectId, emit: () => undefined, signal: abort.signal },
        repoToken: creds.repoToken,
        e2bKey: creds.e2bKey,
        e2bFallbackUserId: creds.e2bFallbackUserId,
      });
      // A mock checkout has no git to rebase.
      if (opened.sandboxId !== null) return opened;
      await opened.dispose();
    } catch {
      /* no checkout: the platform brings the base in instead */
    }
    return null;
  })();

  try {
    // Every cut is read before any branch is rewritten.
    const cuts = new Map<string, string | null>();
    for (const { ticket, parent } of rungs) {
      if (!parent) {
        cuts.set(ticket.id, mergedHead);
      } else if (checkout && ticket.branchName && parent.branchName) {
        const { branchName: own } = ticket;
        const { branchName: under } = parent;
        await checkout.raw.exec(`git fetch origin '${under}' '${own}'`).catch(() => undefined);
        const base = await checkout.raw
          .exec(`git merge-base 'origin/${own}' 'origin/${under}'`)
          .then((r) => (r.exitCode === 0 ? r.stdout.trim() || null : null), () => null);
        cuts.set(ticket.id, base);
      }
    }

    const waiting = new Set<string>();
    for (const { ticket, parent } of rungs) {
      if (parent && waiting.has(parent.id)) {
        waiting.add(ticket.id);
        continue;
      }
      const onto = parent?.branchName ?? target;
      const cut = cuts.get(ticket.id);
      const rebased =
        checkout && ticket.branchName && cut
          ? await rebaseOntoTarget(checkout, { branch: ticket.branchName, target: onto, cut }).catch(() => null)
          : null;
      if (!ticket.prNumber) continue;
      if (!rebased?.ok) {
        waiting.add(ticket.id);
        await handOffToReviewer(ticket, client, onto, hand, { unstack: !parent });
        await client
          .comment(
            ticket.prNumber,
            `${below.key} merged, but this branch could not be rebased onto \`${onto}\`${rebased ? ` (${rebased.reason})` : ""}; it has gone to the Reviewer Agent.`,
          )
          .catch(() => undefined);
        continue;
      }
      if (!parent) {
        await client.retargetPullRequest(ticket.prNumber, target);
        await repo.updateTicket(ticket.id, { stackedOn: null });
      }
      // The same change on a new base: the approval stands, and CI on the new head decides the merge.
      if (rebased.samePatch && ticket.reviewedSha && ticket.reviewedSha === rebased.oldHead) {
        await repo.updateTicket(ticket.id, { reviewedSha: rebased.newHead });
      }
      await client
        .comment(
          ticket.prNumber,
          `${below.key} merged, so this branch now holds only ${ticket.key}'s own commits on top of \`${onto}\`${parent ? "" : `, and its pull request targets \`${target}\``}.`,
        )
        .catch(() => undefined);
    }
  } finally {
    await checkout?.dispose();
  }
}

/** One ticket whose prerequisite has merged: moved onto the merge target, with whatever is stacked on it. */
export async function restack(
  projectId: string,
  ticket: TicketDetail,
  client: VcsClient,
  target: string,
  below: { key: string; prNumber: number | null },
  hand?: HandToReviewer,
): Promise<void> {
  if (!ticket.prNumber) return;
  await restackStack(projectId, [ticket], below, client, target, hand);
}

/** Restacks every ticket built on `merged`'s branch that has its pull request open, and what is stacked on them. */
export async function restackOnto(
  projectId: string,
  merged: TicketDetail,
  client: VcsClient,
  target: string,
  hand?: HandToReviewer,
): Promise<TicketDetail[]> {
  const roots = await stackedAbove(projectId, merged);
  if (roots.length === 0) return [];
  await restackStack(projectId, roots, merged, client, target, hand);
  return roots;
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
