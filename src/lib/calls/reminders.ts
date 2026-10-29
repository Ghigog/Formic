import "server-only";

import { repository } from "@/lib/db";
import type { Meeting, Repository } from "@/lib/db/repository";
import { sendPush, type PushPayload } from "@/lib/push/send";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How often the clock looks for meetings that are starting. */
const TICK_MS = 30_000;

/** What the reminder needs from the outside: the meetings, and a way to push. */
export interface ReminderDeps {
  repo: Pick<Repository, "allMeetingsWithOwner" | "updateMeeting">;
  send: (userId: string, payload: PushPayload) => Promise<unknown>;
}

/**
 * The latest occurrence of a meeting at or before `now`, or null when it has
 * not started yet. Days are UTC; "weekdays" skips Saturday and Sunday.
 */
export function latestOccurrence(meeting: Pick<Meeting, "startsAt" | "repeat">, now: Date): Date | null {
  const start = meeting.startsAt.getTime();
  const at = now.getTime();
  if (at < start) return null;
  if (meeting.repeat === "none") return meeting.startsAt;
  if (meeting.repeat === "weekly" || meeting.repeat === "biweekly") {
    const period = (meeting.repeat === "weekly" ? 7 : 14) * DAY_MS;
    return new Date(start + Math.floor((at - start) / period) * period);
  }
  let day = start + Math.floor((at - start) / DAY_MS) * DAY_MS;
  while (day > start && [0, 6].includes(new Date(day).getUTCDay())) day -= DAY_MS;
  return new Date(day);
}

/**
 * Pushes the owner of every meeting whose occurrence started within the last
 * minute, and records the occurrence so it reminds once, also after a restart.
 * Returns how many meetings it reminded.
 */
export async function remindDueMeetings(
  now: Date = new Date(),
  deps: ReminderDeps = { repo: repository(), send: sendPush },
): Promise<number> {
  let reminded = 0;
  for (const { meeting, ownerId } of await deps.repo.allMeetingsWithOwner()) {
    const occurrence = latestOccurrence(meeting, now);
    if (!occurrence || now.getTime() - occurrence.getTime() >= MINUTE_MS) continue;
    if (meeting.lastRemindedFor && meeting.lastRemindedFor.getTime() >= occurrence.getTime()) continue;
    // Recorded first: a missed reminder is better than one every tick.
    await deps.repo.updateMeeting(meeting.id, { lastRemindedFor: occurrence });
    if (!ownerId) continue;
    await deps.send(ownerId, {
      title: meeting.title,
      body: "Your meeting is starting.",
      url: `/calls/${meeting.id}`,
    });
    reminded++;
  }
  return reminded;
}

let clock: ReturnType<typeof setInterval> | null = null;

/** Runs the reminder on a timer. Started once per server process (src/instrumentation.ts). */
export function startReminderClock(): void {
  if (clock) return;
  clock = setInterval(() => {
    remindDueMeetings().catch((e) => console.warn("[formic] meeting reminders skipped:", e));
  }, TICK_MS);
  clock.unref?.();
}
