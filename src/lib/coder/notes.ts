import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { publish } from "@/lib/events/bus";

/**
 * A person's notes to the agent working a ticket. They are events, so the
 * ticket's feed shows them in order with everything else, and every later
 * run of the ticket is briefed with them.
 */

export const MAX_NOTE = 2_000;

export interface TicketNote {
  seq: number;
  at: Date;
  text: string;
}

export async function ticketNotes(
  projectId: string,
  ticketId: string,
  since?: Date,
): Promise<TicketNote[]> {
  const rows = await repository().ticketEvents(projectId, ticketId, ["ticket.note"], 100);
  return rows.flatMap((r) => {
    const event = r.payload as FormicEvent;
    if (event.type !== "ticket.note") return [];
    if (since && r.at < since) return [];
    return [{ seq: r.seq, at: r.at, text: event.text }];
  });
}

/** The notes' texts, oldest first, for a prompt. */
export async function noteTexts(projectId: string, ticketId: string): Promise<string[]> {
  return (await ticketNotes(projectId, ticketId)).map((n) => n.text);
}

export async function addNote(projectId: string, ticketId: string, text: string): Promise<void> {
  await publish(projectId, { type: "ticket.note", ticketId, text: text.trim().slice(0, MAX_NOTE) });
}
