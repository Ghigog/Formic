import "server-only";

import { repository } from "@/lib/db";
import { MAX_SHARED_NOTE, type FormicEvent } from "@/lib/domain/events";
import { publish } from "@/lib/events/bus";

/**
 * What agents working on the same repository tell each other.
 *
 * File reservations keep two agents out of the same files, but not out of
 * each other's way: one renames an export, changes a signature or finds a
 * trap in the build, and the agents beside it only learn of it at merge
 * time, as a conflict or red CI. A shared note says it while they still
 * work. It is per repository, not per board, like the reservations
 * (docs/concurrency.md): two people's agents on one repository hear each
 * other.
 *
 * Notes are events on the board of the ticket that wrote them, so the
 * ticket's feed shows them with everything else.
 */

/** How far back an agent starting work is briefed. */
const BRIEFING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The most notes an agent is briefed with: the newest ones. */
const BRIEFING_LIMIT = 20;

export interface SharedNote {
  /** Unique across boards: event sequence numbers are global. */
  seq: number;
  /** The key of the ticket whose agent wrote it. */
  from: string;
  text: string;
}

/**
 * Notes on `repoFullName` written by any ticket but `exceptTicketId`, from
 * `since` on (the last day, unset), oldest first.
 */
export async function sharedNotes(
  repoFullName: string,
  options: { exceptTicketId: string; since?: Date; limit?: number },
): Promise<SharedNote[]> {
  const repo = repository();
  const projects = await repo.projectsForRepo(repoFullName);
  const since = options.since ?? new Date(Date.now() - BRIEFING_WINDOW_MS);
  const rows = await repo.eventsOfTypes(
    projects.map((p) => p.id),
    ["repo.note"],
    since,
    options.limit ?? BRIEFING_LIMIT,
  );
  const keys = new Map<string, string | null>();
  const notes: SharedNote[] = [];
  for (const row of rows) {
    const event = row.payload as FormicEvent;
    if (event.type !== "repo.note" || event.ticketId === options.exceptTicketId) continue;
    if (!keys.has(event.ticketId)) {
      keys.set(event.ticketId, (await repo.ticketDetail(event.ticketId))?.key ?? null);
    }
    // A ticket since deleted takes what it said with it.
    const from = keys.get(event.ticketId);
    if (from) notes.push({ seq: row.seq, from, text: event.text });
  }
  return notes;
}

/** The same, for the ticket `ticketId` on `projectId`'s board. */
export async function sharedNotesFor(
  projectId: string,
  ticketId: string,
  since?: Date,
): Promise<SharedNote[]> {
  const project = await repository().projectById(projectId);
  if (!project) return [];
  return sharedNotes(project.repoFullName, { exceptTicketId: ticketId, ...(since ? { since } : {}) });
}

/** A note as one line of a prompt. */
export function sharedNoteLine(note: SharedNote): string {
  return `${note.from}: ${note.text}`;
}

export async function shareNote(projectId: string, ticketId: string, text: string): Promise<void> {
  await publish(projectId, { type: "repo.note", ticketId, text: text.trim().slice(0, MAX_SHARED_NOTE) });
}
