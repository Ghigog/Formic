import "server-only";

import { repository } from "@/lib/db";
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

  const epicKey = (await repo.cardById(ticket.epicId))?.key;
  if (!epicKey) return { ok: false, error: "This ticket's Epic is gone." };
  const siblings = await repo.ticketsForEpic(ticket.epicId);
  const key = nextTicketKey(epicKey, siblings.map((t) => t.key));
  const positions = await repo.columnPositions(projectId, "todo");
  const [created] = await repo.createTickets([
    {
      epicId: ticket.epicId,
      key,
      title: followUp.title,
      description: [followUp.why, `Found while working on ${ticket.key}.`].filter(Boolean).join("\n\n"),
      acceptanceCriteria: [],
      // Where the work was found; it widens on its own when it needs more.
      fileScope: ticket.fileScope,
      storyPoints: followUp.points,
      workType: "tech_debt",
      position: positionBetween(positions.at(-1) ?? null, null),
      dependsOnKeys: [],
    },
  ]);
  await repo.updateTicket(ticketId, { followUps: rest });
  if (created) {
    await publish(projectId, { type: "card.created", cardId: created.id, kind: "ticket", epicId: ticket.epicId });
  }
  return { ok: true, message: `Added ${key}.` };
}
