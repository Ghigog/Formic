import type { Meeting } from "@/lib/db/repository";
import { occurrencesBetween, type Occurrence } from "./occurrences";

const MINUTE = 60_000;
/** A meeting counts as due this long before it starts. */
export const DUE_BEFORE_MINUTES = 15;
/** Meetings have no end time: one counts as running this long after it starts. */
export const RUNNING_FOR_MINUTES = 60;

/** The occurrence that is within 15 minutes of starting or running now, the earliest first. */
export function dueOccurrence(meetings: Meeting[], now: Date): Occurrence | null {
  const from = new Date(now.getTime() - RUNNING_FOR_MINUTES * MINUTE + 1);
  const to = new Date(now.getTime() + DUE_BEFORE_MINUTES * MINUTE + 1);
  return occurrencesBetween(meetings, from, to)[0] ?? null;
}

/** The next occurrence that has not started yet, or is running now. */
export function upNext(meetings: Meeting[], now: Date, days = 14): Occurrence | null {
  const from = new Date(now.getTime() - RUNNING_FOR_MINUTES * MINUTE + 1);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return occurrencesBetween(meetings, from, to)[0] ?? null;
}
