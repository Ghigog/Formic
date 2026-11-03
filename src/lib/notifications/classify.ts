import type { FormicEvent } from "@/lib/domain/events";
import { COLUMN_LABELS } from "@/lib/domain/status";
import type { ColumnId, TicketStatus } from "@/lib/domain/status";
import { columnFor } from "@/lib/domain/status";
import { askedIn, askerOf, isQuestion } from "@/lib/domain/question";

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

/** The longest a PM answer's push says before it is cut. */
const PREVIEW_CHARS = 180;

/** A PM answer as a notification's body: plain text, one paragraph, cut short. */
export function preview(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW_CHARS ? `${plain.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : plain;
}

/** The PM answered in the board's chat, or could not. Pure, like classifyEvent. */
export function classifyPmAnswer(answer: { content: string; failed: boolean }, boardName: string): Notification {
  return {
    kind: "needsAttention",
    title: answer.failed ? `The PM could not answer on ${boardName}` : `The PM answered on ${boardName}`,
    body: preview(answer.content) || "Open the chat to read it.",
    url: "/",
  };
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

  // A question waits on the person, on an Epic as much as a ticket.
  // Named, so a question the PM escalates reads as the PM's.
  if (event.status === "blocked" && isQuestion(event.blockedReason)) {
    const asker = askerOf(event.blockedReason!);
    return {
      kind: "needsAttention",
      title: asker
        ? `${asker} has a question about ${ctx.cardKey} on ${ctx.boardName}`
        : `${ctx.cardKey} on ${ctx.boardName} has a question for you`,
      body: askedIn(event.blockedReason!),
      url,
    };
  }

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
