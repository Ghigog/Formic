export type Repeat = "none" | "weekdays" | "weekly" | "biweekly";

export type Meeting = {
  startsAt: Date;
  repeat: Repeat;
};

/** Days between occurrences for the fixed-interval repeats. */
const INTERVAL_DAYS = { weekly: 7, biweekly: 14 } as const;

/** The meeting's local time of day, `days` calendar days after startsAt (DST-safe). */
function dayOffset(startsAt: Date, days: number): Date {
  return new Date(
    startsAt.getFullYear(),
    startsAt.getMonth(),
    startsAt.getDate() + days,
    startsAt.getHours(),
    startsAt.getMinutes(),
    startsAt.getSeconds(),
    startsAt.getMilliseconds(),
  );
}

function fallsOn(meeting: Meeting, dayIndex: number): boolean {
  switch (meeting.repeat) {
    case "none":
      return dayIndex === 0;
    case "weekdays": {
      const weekday = dayOffset(meeting.startsAt, dayIndex).getDay();
      return weekday !== 0 && weekday !== 6;
    }
    default:
      return dayIndex % INTERVAL_DAYS[meeting.repeat] === 0;
  }
}

/** Occurrences within [from, to), in order. */
export function occurrencesBetween(meeting: Meeting, from: Date, to: Date): Date[] {
  const result: Date[] = [];
  const { startsAt } = meeting;
  // Start a day early so DST shifts cannot skip the first candidate.
  const dayMs = 24 * 60 * 60 * 1000;
  let day = Math.max(0, Math.floor((from.getTime() - startsAt.getTime()) / dayMs) - 1);
  for (; ; day++) {
    const candidate = dayOffset(startsAt, day);
    if (candidate >= to) break;
    if (meeting.repeat === "none" && day > 0) break;
    if (candidate >= from && fallsOn(meeting, day)) result.push(candidate);
  }
  return result;
}

/** The first occurrence strictly after `t`, or null when there is none. */
export function nextOccurrenceAfter(meeting: Meeting, t: Date): Date | null {
  const { startsAt } = meeting;
  if (meeting.repeat === "none") return startsAt > t ? startsAt : null;
  const dayMs = 24 * 60 * 60 * 1000;
  let day = Math.max(0, Math.floor((t.getTime() - startsAt.getTime()) / dayMs) - 1);
  for (; ; day++) {
    const candidate = dayOffset(startsAt, day);
    if (candidate > t && fallsOn(meeting, day)) return candidate;
  }
}
