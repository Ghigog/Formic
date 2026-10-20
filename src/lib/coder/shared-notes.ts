import "server-only";

import { repository } from "@/lib/db";
import { MAX_SHARED_NOTE, type FormicEvent } from "@/lib/domain/events";
import { publish } from "@/lib/events/bus";
import { TRAIL_WINDOW_MS, strongest, type NoteVerdict, type TrailRating } from "@/lib/domain/trail";

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
 *
 * A briefing hands out the strongest notes, not the newest: each fades on its
 * own, agents that found one useful keep it alive, and one found no longer
 * true is dropped (src/lib/domain/trail.ts).
 */

/** The most notes an agent is briefed with. */
const BRIEFING_LIMIT = 20;

/** The most notes and ratings read to rank a briefing from. */
const TRAIL_READ_LIMIT = 1_000;

export interface SharedNote {
  /** Unique across boards: event sequence numbers are global. */
  seq: number;
  /** The key of the ticket whose agent wrote it. */
  from: string;
  text: string;
}

/**
 * Notes on `repoFullName` written by any ticket but `exceptTicketId`, oldest
 * first. With `since`, every note from then on, for an agent already working
 * that hears what is new. Without it, a briefing: the strongest notes.
 */
export async function sharedNotes(
  repoFullName: string,
  options: { exceptTicketId: string; since?: Date; limit?: number; now?: number },
): Promise<SharedNote[]> {
  const repo = repository();
  const projects = await repo.projectsForRepo(repoFullName);
  const now = options.now ?? Date.now();
  const briefing = !options.since;
  const rows = await repo.eventsOfTypes(
    projects.map((p) => p.id),
    briefing ? ["repo.note", "repo.note.rated"] : ["repo.note"],
    options.since ?? new Date(now - TRAIL_WINDOW_MS),
    briefing ? TRAIL_READ_LIMIT : (options.limit ?? BRIEFING_LIMIT),
  );

  const written: Array<{ seq: number; at: Date; ticketId: string; text: string }> = [];
  const ratings: TrailRating[] = [];
  for (const row of rows) {
    const event = row.payload as FormicEvent;
    if (event.type === "repo.note.rated") {
      ratings.push({ noteSeq: event.noteSeq, ticketId: event.ticketId, verdict: event.verdict, at: row.at });
    } else if (event.type === "repo.note" && event.ticketId !== options.exceptTicketId) {
      written.push({ seq: row.seq, at: row.at, ticketId: event.ticketId, text: event.text });
    }
  }
  const picked = briefing ? strongest(written, ratings, now, options.limit ?? BRIEFING_LIMIT) : written;

  const keys = new Map<string, string | null>();
  const notes: SharedNote[] = [];
  for (const note of picked) {
    if (!keys.has(note.ticketId)) {
      keys.set(note.ticketId, (await repo.ticketDetail(note.ticketId))?.key ?? null);
    }
    // A ticket since deleted takes what it said with it.
    const from = keys.get(note.ticketId);
    if (from) notes.push({ seq: note.seq, from, text: note.text });
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

/** A note as one line of a prompt, numbered so the agent can rate it. */
export function sharedNoteLine(note: SharedNote): string {
  return `[note ${note.seq}] ${note.from}: ${note.text}`;
}

export async function shareNote(projectId: string, ticketId: string, text: string): Promise<void> {
  await publish(projectId, { type: "repo.note", ticketId, text: text.trim().slice(0, MAX_SHARED_NOTE) });
}

/** A ticket's agent saying a note helped it, or is no longer true. */
export async function rateNote(projectId: string, ticketId: string, noteSeq: number, verdict: NoteVerdict): Promise<void> {
  await publish(projectId, { type: "repo.note.rated", ticketId, noteSeq, verdict });
}
