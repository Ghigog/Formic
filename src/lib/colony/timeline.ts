import type { BoardCard } from "@/lib/domain/entities";
import { epicBonus, gradeOf, levelOf, mergePoints, pointsOf } from "./game";

/**
 * The timeline: a burndown of story points over a fixed window, the epics as
 * bars, and the forecast finish at the current pace.
 *
 * Days are local calendar days. Day 0 is the window's first; today sits at
 * TODAY so there is room behind it for history and ahead for the forecast.
 */

export const WINDOW_DAYS = 25;
export const TODAY = 9;

const DAY_MS = 86_400_000;

function midnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export type TicketPhase = "done" | "review" | "progress" | "planned";

export interface TimelineTicket {
  id: string;
  key: string;
  title: string;
  sp: number;
  phase: TicketPhase;
  /** Day it starts (or is projected to). */
  start: number;
  /** Day it ends: its merge day + 1, now, or the projected end. */
  end: number;
  /** Day it merged, when it has. */
  mergedDay: number | null;
}

export interface TimelineEpic {
  id: string;
  key: string;
  title: string;
  doneSp: number;
  totalSp: number;
  merged: boolean;
  start: number;
  end: number;
  /** Points per story point merged, or null before any merge. */
  yieldRatio: number | null;
  grade: ReturnType<typeof gradeOf> | null;
  tickets: TimelineTicket[];
}

export interface TimelineDay {
  date: Date;
  /** Story points merged that day. */
  sp: number;
  /** Points those merges earned. */
  pts: number;
  /** Story points still open at the end of the day. */
  remaining: number;
}

export interface Timeline {
  start: Date;
  /** Fractional day index for this moment. */
  now: number;
  /** Open story points at the window's start. The burndown's top. */
  total: number;
  remaining: number;
  /** Story points per day, over the window so far. */
  velocity: number;
  /** Fractional day the work finishes at this pace, or null with no pace. */
  forecast: number | null;
  days: TimelineDay[];
  /** Burndown points: [day, remaining]. */
  actual: Array<[number, number]>;
  epics: TimelineEpic[];
  /** Level-ups inside the window: the day and the level reached. */
  levels: Array<{ day: number; level: number }>;
  /** Consecutive days with a merge, ending today (or yesterday). */
  streak: number;
  bestDay: number | null;
  /** The in-review ticket whose merge would pull the finish in most. */
  boost: { key: string; days: number } | null;
  /** Points per story point across the window. */
  yieldRatio: number | null;
}

/** Day index of an ISO time, relative to the window start. */
function dayOf(iso: string | null | undefined, start: Date): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((midnight(d).getTime() - start.getTime()) / DAY_MS);
}

export function buildTimeline(cards: BoardCard[], at: Date = new Date()): Timeline {
  const start = new Date(midnight(at).getTime() - TODAY * DAY_MS);
  // DST moves a midnight by an hour; re-anchor so day arithmetic stays whole.
  const startDay = midnight(new Date(start.getTime() + DAY_MS / 2));
  const now = TODAY + (at.getTime() - midnight(at).getTime()) / DAY_MS;

  const tickets = cards.filter((c) => c.kind === "ticket");
  const epicsById = new Map(cards.filter((c) => c.kind === "epic").map((c) => [c.id, c]));

  const byDay = Array.from({ length: WINDOW_DAYS }, () => ({ sp: 0, pts: 0 }));
  const xpByDay = Array.from({ length: WINDOW_DAYS }, () => 0);
  let xpBefore = 0;
  let openAtStart = 0;
  let mergedInWindow = 0;
  let ptsInWindow = 0;

  const plotted = new Map<string, TimelineTicket>();
  for (const t of tickets) {
    const sp = pointsOf(t);
    const merged = t.status === "merged";
    // Older tickets merged before the server stamped merges: their last change.
    const mergedDay = merged
      ? Math.min(TODAY, dayOf(t.mergedAt ?? t.updatedAt, startDay) ?? TODAY)
      : null;
    if (mergedDay !== null && mergedDay < 0) {
      xpBefore += mergePoints(t);
      continue;
    }
    openAtStart += sp;
    if (mergedDay !== null) {
      byDay[mergedDay]!.sp += sp;
      byDay[mergedDay]!.pts += mergePoints(t);
      xpByDay[mergedDay]! += mergePoints(t);
      mergedInWindow += sp;
      ptsInWindow += mergePoints(t);
    }
    const phase: TicketPhase = merged
      ? "done"
      : t.status === "review"
        ? "review"
        : t.status === "running"
          ? "progress"
          : "planned";
    const started = dayOf(t.startedAt, startDay);
    plotted.set(t.id, {
      id: t.id,
      key: t.key,
      title: t.title,
      sp,
      phase,
      start: Math.max(0, started ?? (phase === "planned" ? TODAY + 1 : Math.min(mergedDay ?? TODAY, TODAY))),
      end: 0,
      mergedDay,
    });
  }

  for (const epic of epicsById.values()) {
    if (epic.status !== "merged") continue;
    // An epic merges with its last ticket.
    const last = tickets
      .filter((t) => t.epicId === epic.id && t.mergedAt)
      .map((t) => t.mergedAt!)
      .sort()
      .at(-1);
    const d = dayOf(last ?? epic.updatedAt, startDay);
    const bonus = epicBonus(epic, cards);
    if (d === null || d > TODAY) xpByDay[TODAY]! += bonus;
    else if (d < 0) xpBefore += bonus;
    else xpByDay[d]! += bonus;
  }

  // Ends: merged and in-flight work is known; planned work queues behind
  // whatever it depends on, a day per two story points.
  const ends = new Map<string, number>();
  const endOf = (id: string, seen = new Set<string>()): number => {
    const known = ends.get(id);
    if (known !== undefined) return known;
    const t = plotted.get(id);
    if (!t) return TODAY + 1;
    let end: number;
    if (t.mergedDay !== null) end = t.mergedDay + 1;
    else if (t.phase !== "planned") end = Math.max(now, TODAY + 1 + Math.ceil(t.sp / 4));
    else {
      seen.add(id);
      const card = tickets.find((c) => c.id === id);
      const after = (card?.dependsOn ?? [])
        .filter((d) => !seen.has(d))
        .map((d) => endOf(d, seen));
      t.start = Math.max(TODAY + 1, ...after);
      end = t.start + Math.max(1, Math.round(t.sp / 2));
    }
    ends.set(id, end);
    t.end = end;
    return end;
  };
  for (const id of plotted.keys()) endOf(id);

  // Burndown: open story points at the end of each day up to today.
  const days: TimelineDay[] = [];
  let remaining = openAtStart;
  const actual: Array<[number, number]> = [[0, openAtStart]];
  for (let d = 0; d < WINDOW_DAYS; d++) {
    if (d <= TODAY) remaining -= byDay[d]!.sp;
    days.push({
      date: new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + d),
      sp: byDay[d]!.sp,
      pts: byDay[d]!.pts,
      remaining,
    });
    if (d < TODAY) actual.push([d + 1, remaining]);
  }
  actual.push([now, remaining]);

  const velocity = mergedInWindow / now;
  const forecast = remaining === 0 ? now : velocity > 0 ? now + remaining / velocity : null;

  // Level-ups, from XP at the window's start through each day's merges.
  const levels: Timeline["levels"] = [];
  let xp = xpBefore;
  for (let d = 0; d <= TODAY; d++) {
    const before = levelOf(xp);
    xp += xpByDay[d]!;
    for (let lv = before + 1; lv <= levelOf(xp); lv++) {
      levels.push({ day: d === TODAY ? now : d + 0.7, level: lv });
    }
  }

  const epics: TimelineEpic[] = [];
  for (const epic of epicsById.values()) {
    const its = [...plotted.values()]
      .filter((t) => tickets.find((c) => c.id === t.id)?.epicId === epic.id)
      .sort((a, b) => a.start - b.start);
    if (!its.length) continue;
    const doneSp = its.filter((t) => t.mergedDay !== null).reduce((n, t) => n + t.sp, 0);
    const totalSp = its.reduce((n, t) => n + t.sp, 0);
    const merged = epic.status === "merged";
    const pts = its
      .filter((t) => t.mergedDay !== null)
      .reduce((n, t) => n + mergePoints(tickets.find((c) => c.id === t.id)!), 0);
    // The completion bonus counts once merged, and is assumed on the way:
    // an epic merged at 1× throughout grades A, and heat is what makes an S.
    const ratio = doneSp ? (pts + doneSp) / doneSp : null;
    epics.push({
      id: epic.id,
      key: epic.key,
      title: epic.title,
      doneSp,
      totalSp,
      merged,
      start: Math.min(...its.map((t) => t.start)),
      end: Math.max(...its.map((t) => t.end)),
      yieldRatio: ratio,
      grade: ratio === null ? null : gradeOf(ratio),
      tickets: its,
    });
  }
  epics.sort((a, b) => a.start - b.start);

  let streak = 0;
  let d = byDay[TODAY]!.sp > 0 ? TODAY : TODAY - 1;
  while (d >= 0 && byDay[d]!.sp > 0) {
    streak++;
    d--;
  }
  let bestDay: number | null = null;
  byDay.forEach((v, i) => {
    if (v.sp > 0 && (bestDay === null || v.sp > byDay[bestDay]!.sp)) bestDay = i;
  });

  let boost: Timeline["boost"] = null;
  const candidate = tickets
    .filter((t) => t.status === "review")
    .sort((a, b) => pointsOf(b) - pointsOf(a))[0];
  if (candidate && velocity > 0 && forecast !== null && remaining > 0) {
    const sp = pointsOf(candidate);
    const v2 = (mergedInWindow + sp) / now;
    const f2 = now + (remaining - sp) / v2;
    const gain = forecast - f2;
    if (gain >= 0.1) boost = { key: candidate.key, days: gain };
  }

  return {
    start: startDay,
    now,
    total: openAtStart,
    remaining,
    velocity,
    forecast,
    days,
    actual,
    epics,
    levels,
    streak,
    bestDay,
    boost,
    yieldRatio: mergedInWindow ? ptsInWindow / mergedInWindow : null,
  };
}
