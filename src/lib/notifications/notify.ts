import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { columnFor, type ColumnId, type TicketStatus } from "@/lib/domain/status";
import { sendPush } from "@/lib/push/send";
import { classifyEvent } from "./classify";

declare global {
  var __formicTicketColumns: Map<string, ColumnId> | undefined;
}

/**
 * Whether a ticket's status change leaves it in the column it was already
 * in, such as queued then running, both In Progress. Remembers the column
 * for next time. Kept in memory: after a restart, a ticket's first move
 * notifies whether it changed column or not.
 */
function sameColumn(cardId: string, status: string, stalledIn: string | null): boolean {
  globalThis.__formicTicketColumns ??= new Map();
  const columns = globalThis.__formicTicketColumns;
  const column = columnFor(status as TicketStatus, stalledIn as ColumnId | null);
  const same = columns.get(cardId) === column;
  columns.set(cardId, column);
  return same;
}

/**
 * Pushes a board event to the board's owner, when it is worth one and they
 * have that kind switched on. Never throws: a push failure must not fail the
 * event that caused it.
 */
export async function notifyOwner(projectId: string, event: FormicEvent): Promise<void> {
  try {
    if (event.type !== "card.status" && event.type !== "budget.exhausted") return;
    const unmoved =
      event.type === "card.status" && event.kind === "ticket" && sameColumn(event.cardId, event.status, event.stalledIn);
    const repo = repository();
    const project = await repo.projectById(projectId);
    if (!project?.ownerId) return;

    let cardKey = "";
    let cardTitle = "";
    if (event.type === "card.status") {
      const card = await repo.cardById(event.cardId);
      if (!card) return;
      cardKey = card.key;
      cardTitle = card.title;
    }
    const notification = classifyEvent(event, { cardKey, cardTitle, boardName: project.name });
    if (!notification) return;
    if (notification.kind === "ticketMoved" && unmoved) return;

    const prefs = await repo.pushPreferences(project.ownerId);
    if (!prefs[notification.kind]) return;
    await sendPush(project.ownerId, notification);
  } catch {
    // Best-effort, like every other subscriber of the bus.
  }
}
