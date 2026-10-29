import type { Meeting } from "@/lib/db/repository";

/** One time a meeting happens: the meeting and the instant it starts. */
export interface Occurrence {
  meeting: Meeting;
  at: Date;
}

const REPEAT_DAYS = { weekly: 7, biweekly: 14 } as const;

/**
 * Every time the meetings start within [from, to), soonest first. A repeat
 * keeps the meeting's time of day on the local clock and never occurs before
 * the meeting's own start.
 */
export function occurrencesBetween(meetings: Meeting[], from: Date, to: Date): Occurrence[] {
  const found: Occurrence[] = [];
  for (const meeting of meetings) {
    const start = meeting.startsAt;
    const day = new Date(start);
    for (let i = 0; day < to; i++) {
      if (meeting.repeat === "none" && i > 0) break;
      const weekday = day.getDay();
      const counts = meeting.repeat !== "weekdays" || (weekday !== 0 && weekday !== 6);
      if (counts && day >= from) found.push({ meeting, at: new Date(day) });
      const step = meeting.repeat === "weekdays" ? 1 : meeting.repeat === "none" ? 1 : REPEAT_DAYS[meeting.repeat];
      day.setDate(day.getDate() + step);
    }
  }
  return found.sort((a, b) => a.at.getTime() - b.at.getTime());
}
