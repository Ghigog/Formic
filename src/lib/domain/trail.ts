/**
 * How strong a shared note is, the way an ant trail is: it fades on its own,
 * and every agent that finds it useful lays it down again.
 *
 * A note is worth 1 when it is written and halves every NOTE_HALF_LIFE_MS.
 * An agent that says the note helped adds HELPED, which fades much slower,
 * so a note that keeps saving agents time keeps being handed out for weeks.
 * An agent that finds it no longer true adds OUTDATED, which cancels it
 * outright, the way a "no entry" scent closes a trail that leads nowhere.
 *
 * Briefings hand out the strongest notes, not the newest ones.
 */

export const NOTE_HALF_LIFE_MS = 24 * 60 * 60 * 1000;
export const RATING_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export const HELPED = 1;
export const OUTDATED = -2;

/** Below this a note is not handed out: an unrated note lasts about three days. */
export const FAINT = 0.1;

/** How far back notes are read at all. Past this even a strong trail has gone cold. */
export const TRAIL_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export type NoteVerdict = "helped" | "outdated";

export interface TrailNote {
  seq: number;
  at: Date;
}

export interface TrailRating {
  /** The note rated. */
  noteSeq: number;
  /** The ticket whose agent rated it. One ticket's latest rating counts once. */
  ticketId: string;
  verdict: NoteVerdict;
  at: Date;
}

function fade(value: number, ageMs: number, halfLifeMs: number): number {
  return value * Math.pow(2, -Math.max(0, ageMs) / halfLifeMs);
}

/** A note's strength at `now`, given every rating ever made of it. */
export function strengthOf(note: TrailNote, ratings: readonly TrailRating[], now: number): number {
  const latest = new Map<string, TrailRating>();
  for (const r of ratings) {
    if (r.noteSeq !== note.seq) continue;
    const prior = latest.get(r.ticketId);
    if (!prior || prior.at.getTime() <= r.at.getTime()) latest.set(r.ticketId, r);
  }
  let strength = fade(1, now - note.at.getTime(), NOTE_HALF_LIFE_MS);
  for (const r of latest.values()) {
    strength += fade(r.verdict === "helped" ? HELPED : OUTDATED, now - r.at.getTime(), RATING_HALF_LIFE_MS);
  }
  return strength;
}

/**
 * The `limit` strongest notes still above FAINT, oldest first, so a briefing
 * reads in the order things happened.
 */
export function strongest<T extends TrailNote>(
  notes: readonly T[],
  ratings: readonly TrailRating[],
  now: number,
  limit: number,
): T[] {
  return notes
    .map((note) => ({ note, strength: strengthOf(note, ratings, now) }))
    .filter((n) => n.strength >= FAINT)
    .sort((a, b) => b.strength - a.strength || b.note.seq - a.note.seq)
    .slice(0, limit)
    .map((n) => n.note)
    .sort((a, b) => a.seq - b.seq);
}
