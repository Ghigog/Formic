import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { publish } from "@/lib/events/bus";
import { MAX_NOTE } from "@/lib/coder/notes";

/**
 * A person's instructions to the Architect Agent breaking down an Epic. Kept
 * the same way a ticket's notes are: events, so every later decomposition is
 * briefed with them, not just the one running when the message arrived.
 */

export interface EpicNote {
  seq: number;
  at: Date;
  text: string;
}

export async function epicNotes(projectId: string, epicId: string): Promise<EpicNote[]> {
  const rows = await repository().epicEvents(projectId, epicId, ["epic.note"], 100);
  return rows.flatMap((r) => {
    const event = r.payload as FormicEvent;
    if (event.type !== "epic.note") return [];
    return [{ seq: r.seq, at: r.at, text: event.text }];
  });
}

/** The notes' texts, oldest first, for a prompt. */
export async function epicNoteTexts(projectId: string, epicId: string): Promise<string[]> {
  return (await epicNotes(projectId, epicId)).map((n) => n.text);
}

/**
 * A request with what the person has said about it since, for the Product
 * Agent writing its PRD again.
 */
export function withEpicNotes(request: string, notes: string[]): string {
  if (notes.length === 0) return request;
  return [
    request,
    "",
    "What the person has said about it since, oldest first. Where it disagrees with the request above, the newest wins:",
    ...notes.map((n) => `- ${n}`),
  ].join("\n");
}

export async function addEpicNote(projectId: string, epicId: string, text: string): Promise<void> {
  await publish(projectId, { type: "epic.note", epicId, text: text.trim().slice(0, MAX_NOTE) });
}
