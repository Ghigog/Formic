import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { columnFor, type ColumnId, type TicketStatus } from "@/lib/domain/status";
import { sendPush } from "@/lib/push/send";
import { classifyEvent, type Notification } from "./classify";

type CardStatus = FormicEvent & { type: "card.status" };

/** What a card's owner was last told about it: where it was, and why it stopped. */
interface CardSeen {
  status: string;
  /** Where a ticket shows on the board; null for an Epic. */
  column: ColumnId | null;
  /** The stop's status and reason; null while it is not blocked or failed. */
  stall: string | null;
}

/** The same push to the same person within this long is a repeat. */
const REPEAT_WINDOW_MS = 15 * 60_000;

declare global {
  var __formicCardSeen: Map<string, CardSeen> | undefined;
  var __formicPushesSent: Map<string, number> | undefined;
}

function seen(): Map<string, CardSeen> {
  return (globalThis.__formicCardSeen ??= new Map());
}

function sent(): Map<string, number> {
  return (globalThis.__formicPushesSent ??= new Map());
}

/** Forgets what was sent, for tests. */
export function resetNotified(): void {
  seen().clear();
  sent().clear();
}

function cardSeen(event: Pick<CardStatus, "kind" | "status" | "stalledIn" | "blockedReason">): CardSeen {
  const stopped = event.status === "blocked" || event.status === "failed";
  return {
    status: event.status,
    column: event.kind === "ticket" ? columnFor(event.status as TicketStatus, event.stalledIn as ColumnId | null) : null,
    stall: stopped ? `${event.status}|${event.blockedReason ?? ""}` : null,
  };
}

/**
 * Where a card was before this event. Remembered in memory, and read from the
 * event log the first time a card is seen, so a restart does not make the
 * next status of every card look new.
 */
async function before(projectId: string, event: CardStatus, seq?: number): Promise<CardSeen | undefined> {
  const remembered = seen().get(event.cardId);
  if (remembered || seq === undefined) return remembered;
  // Unread, the push goes out: one too many beats one missed.
  const previous = (await repository()
    .cardStatusBefore(projectId, event.cardId, seq)
    .catch(() => null)) as CardStatus | null;
  return previous?.status ? cardSeen(previous) : undefined;
}

/** Whether a push tells the person nothing they were not just told. */
function repeats(notification: Notification, was: CardSeen | undefined, now: CardSeen | undefined): boolean {
  if (!was || !now) return false;
  switch (notification.kind) {
    // queued then running are both In Progress.
    case "ticketMoved":
      return was.column === now.column;
    // A sweep that parks a parked ticket again, for the same reason.
    case "needsAttention":
      return was.stall === now.stall;
    case "epicCompleted":
      return was.status === now.status;
  }
}

/**
 * Whether this person was sent the very same push a moment ago: stopping an
 * Epic stops each of its runs, and each says why. Records it when not.
 */
function sentRecently(userId: string, notification: Notification): boolean {
  const now = Date.now();
  for (const [key, at] of sent()) if (now - at > REPEAT_WINDOW_MS) sent().delete(key);
  const key = `${userId}\n${notification.title}\n${notification.body}`;
  if (sent().has(key)) return true;
  sent().set(key, now);
  return false;
}

/**
 * Pushes a board event to the board's owner, when it is worth one, says
 * something new, and they have that kind switched on. Never throws: a push
 * failure must not fail the event that caused it.
 */
export async function notifyOwner(projectId: string, event: FormicEvent, seq?: number): Promise<void> {
  try {
    if (event.type !== "card.status" && event.type !== "budget.exhausted") return;

    let was: CardSeen | undefined;
    let now: CardSeen | undefined;
    if (event.type === "card.status") {
      was = await before(projectId, event, seq);
      now = cardSeen(event);
      seen().set(event.cardId, now);
    }

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
    if (!notification || repeats(notification, was, now)) return;

    const prefs = await repo.pushPreferences(project.ownerId);
    if (!prefs[notification.kind]) return;
    if (sentRecently(project.ownerId, notification)) return;
    await sendPush(project.ownerId, notification);
  } catch {
    // Best-effort, like every other subscriber of the bus.
  }
}
