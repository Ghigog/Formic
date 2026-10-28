import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { columnFor, type ColumnId, type TicketStatus } from "@/lib/domain/status";
import { sendPush } from "@/lib/push/send";
import { classifyEvent } from "./classify";

declare global {
  var __formicTicketSeen: Map<string, TicketSeen> | undefined;
}

/** What a ticket's owner last heard about it: its column, and why it stopped. */
interface TicketSeen {
  column: ColumnId;
  /** The stop's status and reason; null while it is not blocked or failed. */
  stall: string | null;
}

/**
 * Remembers where a ticket now is and returns where it was, so a status
 * that does not change what the person sees sends nothing: queued then
 * running are both In Progress, and a sweep that parks a parked ticket again
 * says nothing new. Kept in memory: after a restart, a ticket's first change
 * notifies.
 */
function rememberTicket(event: FormicEvent & { type: "card.status" }): TicketSeen | undefined {
  globalThis.__formicTicketSeen ??= new Map();
  const seen = globalThis.__formicTicketSeen;
  const before = seen.get(event.cardId);
  const stopped = event.status === "blocked" || event.status === "failed";
  seen.set(event.cardId, {
    column: columnFor(event.status as TicketStatus, event.stalledIn as ColumnId | null),
    stall: stopped ? `${event.status}|${event.blockedReason ?? ""}` : null,
  });
  return before;
}

/**
 * Pushes a board event to the board's owner, when it is worth one and they
 * have that kind switched on. Never throws: a push failure must not fail the
 * event that caused it.
 */
export async function notifyOwner(projectId: string, event: FormicEvent): Promise<void> {
  try {
    if (event.type !== "card.status" && event.type !== "budget.exhausted") return;
    const ticket = event.type === "card.status" && event.kind === "ticket";
    const before = ticket ? rememberTicket(event) : undefined;
    const now = ticket ? globalThis.__formicTicketSeen?.get(event.cardId) : undefined;
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
    if (before && now) {
      if (notification.kind === "ticketMoved" && before.column === now.column) return;
      if (notification.kind === "needsAttention" && before.stall === now.stall) return;
    }

    const prefs = await repo.pushPreferences(project.ownerId);
    if (!prefs[notification.kind]) return;
    await sendPush(project.ownerId, notification);
  } catch {
    // Best-effort, like every other subscriber of the bus.
  }
}
