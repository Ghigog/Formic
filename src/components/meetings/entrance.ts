import type { Occurrence } from "@/lib/meetings/occurrences";

/** The most plops an entrance plays; the rest of the meetings just show. */
export const MAX_PLOPS = 20;
/** The even beat between plops, in milliseconds. */
export const BEAT_MS = 110;

export interface Plop {
  /** Which occurrence falls: the meeting's id and its start, as the calendar keys it. */
  key: string;
  /** Milliseconds after the plops begin. */
  delay: number;
  /** 0 (evening) to 1 (morning): the plop's value, which sets its pitch. */
  pitch: number;
}

/** The calendar's key for one occurrence of a meeting. */
export const occurrenceKey = (o: Occurrence) => `${o.meeting.id}-${o.at.getTime()}`;

/** Morning is high and evening low, across the hours the calendar offers (07:00 to 21:00). */
export function pitchOf(at: Date): number {
  const hour = at.getHours() + at.getMinutes() / 60;
  return Math.min(1, Math.max(0, (21 - hour) / 14));
}

/**
 * The visible occurrences as plops in time order, one beat apart however far
 * apart the meetings are (so repeats do not drum), capped at MAX_PLOPS.
 */
export function plopSchedule(occurrences: Occurrence[]): Plop[] {
  return [...occurrences]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, MAX_PLOPS)
    .map((o, i) => ({ key: occurrenceKey(o), delay: i * BEAT_MS, pitch: pitchOf(o.at) }));
}
