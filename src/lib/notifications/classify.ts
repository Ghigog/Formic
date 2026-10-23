import type { FormicEvent } from "@/lib/domain/events";
import { COLUMN_LABELS } from "@/lib/domain/status";
import type { ColumnId, TicketStatus } from "@/lib/domain/status";
import { columnFor } from "@/lib/domain/status";

export type NotificationKind = "ticketMoved" | "epicCompleted" | "needsAttention";

export interface Notification {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Where tapping it goes. */
  url: string;
}

/** What the event alone does not say: the card's name and the board it is on. */
export interface NotificationContext {
  /** The card's key, such as T-5; for an Epic, its title. */
  cardKey: string;
  cardTitle: string;
  boardName: string;
}

/**
 * Whether a board event is worth a push, and what it says. Pure: the caller
 * looks up the context and decides who hears it.
 */
export function classifyEvent(event: FormicEvent, ctx: NotificationContext): Notification | null {
  const url = "/";
  if (event.type === "budget.exhausted") {
    return {
      kind: "needsAttention",
      title: `${ctx.boardName} needs your attention`,
      body: event.detail,
      url,
    };
  }
  if (event.type !== "card.status") return null;

  if (event.kind === "epic") {
    if (event.status !== "merged") return null;
    return {
      kind: "epicCompleted",
      title: `${ctx.boardName}: Epic completed`,
      body: `${ctx.cardTitle} is done`,
      url,
    };
  }

  if (event.status === "blocked" || event.status === "failed") {
    return {
      kind: "needsAttention",
      title: `${ctx.cardKey} on ${ctx.boardName} needs your attention`,
      body: event.blockedReason ?? `${ctx.cardTitle} ${event.status === "failed" ? "failed" : "is blocked"}`,
      url,
    };
  }

  const column: ColumnId = columnFor(event.status as TicketStatus, null);
  return {
    kind: "ticketMoved",
    title: ctx.cardTitle,
    body: `${ctx.cardKey} on ${ctx.boardName} moved to ${COLUMN_LABELS[column]}`,
    url,
  };
}
