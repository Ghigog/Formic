import "server-only";

import { startedBy } from "@/lib/auth/actor";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import type { BoardCard } from "@/lib/domain/entities";
import { mergeFollowUps, type FollowUp } from "@/lib/agents/follow-ups";
import { publish } from "@/lib/events/bus";
import { positionBetween } from "@/lib/ordering";

/**
 * What agents propose as tickets of their own (FOLLOW_UP_RULE), kept on the
 * ticket that found them until the person adds or dismisses each one.
 */

/** Keeps what an agent proposed on its ticket, beside what was there. */
export async function recordFollowUps(ticketId: string, more: FollowUp[]): Promise<void> {
  if (more.length === 0) return;
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket) return;
  await repo.updateTicket(ticketId, { followUps: mergeFollowUps(ticket.followUps, more) });
}

/** The next key on an Epic, after the tickets it already has: EPIC-n-Tm. */
export function nextTicketKey(epicKey: string, taken: readonly string[]): string {
  const prefix = `${epicKey}-T`;
  const highest = taken
    .filter((k) => k.startsWith(prefix))
    .map((k) => Number.parseInt(k.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}${highest + 1}`;
}

export type FollowUpAnswer = { ok: true; message: string } | { ok: false; error: string };

/**
 * Makes a follow-up a tech debt ticket at the end of To Do. On a real Epic it
 * joins that Epic (EPIC-n-Tm); from a standalone ticket it becomes a
 * standalone ticket of its own (T-n), as createTodoItem makes them.
 */
export async function addFollowUpTicket(
  projectId: string,
  source: TicketDetail,
  followUp: FollowUp,
): Promise<BoardCard> {
  const repo = repository();
  // cardById is null for a standalone holder in the database, and the holder
  // itself in memory; either way only a real Epic has an EPIC-n key to extend.
  const epic = await repo.cardById(source.epicId);
  const realEpic = epic && !epic.standalone ? epic : null;

  let epicId = source.epicId;
  let key: string;
  if (realEpic) {
    const siblings = await repo.ticketsForEpic(epicId);
    key = nextTicketKey(realEpic.key, siblings.map((t) => t.key));
  } else {
    const holder = await repo.createEpic({
      projectId,
      title: followUp.title,
      rawRequest: followUp.title,
      position: 0,
    });
    await repo.setStandalone(holder.id, true);
    await startedBy(holder.id);
    epicId = holder.id;
    key = `T-${await repo.nextStandaloneTicketNumber(projectId)}`;
  }

  const positions = await repo.columnPositions(projectId, "todo");
  const [created] = await repo.createTickets([
    {
      epicId,
      key,
      title: followUp.title,
      description: [followUp.why, `Found while working on ${source.key}.`].filter(Boolean).join("\n\n"),
      acceptanceCriteria: [],
      // Where the work was found; it widens on its own when it needs more.
      fileScope: source.fileScope,
      storyPoints: followUp.points,
      workType: "tech_debt",
      position: positionBetween(positions.at(-1) ?? null, null),
      dependsOnKeys: [],
    },
  ]);
  const card = created!;
  if (!realEpic) {
    await repo.move({
      cardId: card.id,
      kind: "ticket",
      status: "ready",
      stalledIn: null,
      position: card.position,
      detached: true,
    });
  }
  await publish(projectId, { type: "card.created", cardId: card.id, kind: "ticket", epicId });
  return card;
}

/**
 * The person's answer to one follow-up: add it as a tech debt ticket on the
 * same Epic, at the end of To Do, or dismiss it. Either way it leaves the list.
 */
export async function answerFollowUp(
  projectId: string,
  ticketId: string,
  index: number,
  add: boolean,
): Promise<FollowUpAnswer> {
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  const followUp = ticket?.followUps[index];
  if (!ticket || !followUp) return { ok: false, error: "That follow-up is no longer there." };

  const rest = ticket.followUps.filter((_, i) => i !== index);
  if (!add) {
    await repo.updateTicket(ticketId, { followUps: rest });
    return { ok: true, message: "Dismissed." };
  }

  const created = await addFollowUpTicket(projectId, ticket, followUp);
  await repo.updateTicket(ticketId, { followUps: rest });
  return { ok: true, message: `Added ${created.key}.` };
}
