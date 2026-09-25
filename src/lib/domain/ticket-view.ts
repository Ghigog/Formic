import type { BoardCard, PlanStep } from "./entities";
import type { FormicEvent } from "./events";

/**
 * A ticket as its own view shows it: the ticket itself, where it is, the
 * plan the agent is working through, and what the agent thought and did.
 */

/** One line of what an agent thought or did on a ticket. */
export interface TicketActivity {
  /** The event it came from, for ordering and de-duplication. */
  seq: number;
  at: string;
  /**
   * Reasoning, what it said, an action it took, a person's note to it, or
   * the column's agent answering that note.
   */
  kind: "thinking" | "text" | "action" | "note" | "reply";
  text: string;
  /** Replies only: which agent answered, or null for a notice. */
  agent?: string | null;
}

export interface TicketView {
  card: BoardCard;
  epic: { id: string; key: string; title: string } | null;
  description: string;
  acceptanceCriteria: string[];
  branchName: string | null;
  summary: string | null;
  dependsOn: Array<{ id: string; key: string; title: string; status: string }>;
  plan: PlanStep[];
  /** Steps outside the repository the person has to take themselves. */
  handoff: string[];
  activity: TicketActivity[];
  /** Whether an agent is working it now, so it can be stopped. */
  canStop: boolean;
}

/** The event types a ticket's activity is made of. */
export const ACTIVITY_EVENTS = ["run.thought", "run.progress", "ticket.note", "ticket.reply"] as const;

/** An event as a line of activity, or null when it is not one for this ticket. */
export function activityOf(
  event: FormicEvent,
  ticketId: string,
  seq: number,
  at: string,
): TicketActivity | null {
  if (event.type === "run.thought" && event.ticketId === ticketId) {
    return { seq, at, kind: event.kind, text: event.text };
  }
  if (event.type === "ticket.note" && event.ticketId === ticketId) {
    return { seq, at, kind: "note", text: event.text };
  }
  if (event.type === "ticket.reply" && event.ticketId === ticketId) {
    return { seq, at, kind: "reply", text: event.text, agent: event.agent };
  }
  if (event.type === "run.progress" && event.ticketId === ticketId) {
    return { seq, at, kind: "action", text: event.label };
  }
  return null;
}

/** Appends a line, dropping an action that only repeats the one before it. */
export function appendActivity(list: TicketActivity[], item: TicketActivity): TicketActivity[] {
  if (list.some((a) => a.seq === item.seq)) return list;
  const last = list.at(-1);
  if (last && item.kind === "action" && last.kind === "action" && last.text === item.text) return list;
  return [...list, item];
}
