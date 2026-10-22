import { COLUMNS, type ColumnId } from "./status";

/**
 * Board KPIs as pure functions over plain input: no database, no clock. The
 * caller maps stored tickets and their column history to these shapes and
 * passes `now`.
 *
 * Empty input gives empty values (null or 0), never NaN.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The recent window of the KPI view: 30 days against all time. */
export const RECENT_WINDOW_MS = 30 * DAY_MS;
export type KpiWindow = "recent" | "all";

/** One stay of a ticket in a column. */
export interface ColumnStay {
  column: ColumnId;
  enteredAt: Date;
  /** Null while the ticket is still there. */
  leftAt: Date | null;
  /** Written by Formic to repair history, not a real stay. Never counted as time. */
  synthetic?: boolean;
}

export interface KpiTicket {
  id: string;
  /** Story points, or null when not estimated. */
  storyPoints: number | null;
  /** Column stays in order, oldest first. */
  stays: ColumnStay[];
  /** Agent attempts made on the ticket. */
  attempts: number;
  /** Times its agent asked for files outside the scope. */
  scopeRequests: number;
  /** Ended blocked or failed. */
  blockedOrFailed: boolean;
  costUsd: number;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** When the ticket reached Done, or null. */
function doneAt(t: KpiTicket): Date | null {
  const stay = [...t.stays].reverse().find((s) => s.column === "done");
  return stay ? stay.enteredAt : null;
}

/** The first time a ticket entered a column, real entries only. */
function firstEntry(t: KpiTicket, column: ColumnId): Date | null {
  return t.stays.find((s) => s.column === column && !s.synthetic)?.enteredAt ?? null;
}

/**
 * Tickets that count in a window: those finished in it, or, if not finished,
 * those whose latest stay began in it. "all" keeps every ticket.
 */
export function inWindow(tickets: KpiTicket[], window: KpiWindow, now: number): KpiTicket[] {
  if (window === "all") return tickets;
  const from = now - RECENT_WINDOW_MS;
  return tickets.filter((t) => {
    const at = doneAt(t) ?? t.stays[t.stays.length - 1]?.enteredAt;
    return at !== undefined && at.getTime() >= from;
  });
}

/** Milliseconds a ticket spent in each column. Synthetic stays are left out. */
export function timeInColumn(t: KpiTicket, now: number): Record<ColumnId, number> {
  const out = Object.fromEntries(COLUMNS.map((c) => [c, 0])) as Record<ColumnId, number>;
  for (const s of t.stays) {
    if (s.synthetic) continue;
    const end = s.leftAt ? s.leftAt.getTime() : now;
    out[s.column] += Math.max(0, end - s.enteredAt.getTime());
  }
  return out;
}

/** Average milliseconds per column over the tickets that were ever in it; null for none. */
export function averageTimePerColumn(tickets: KpiTicket[], now: number): Record<ColumnId, number | null> {
  const out = {} as Record<ColumnId, number | null>;
  for (const c of COLUMNS) {
    const spent = tickets
      .filter((t) => t.stays.some((s) => s.column === c && !s.synthetic))
      .map((t) => timeInColumn(t, now)[c]);
    out[c] = mean(spent);
  }
  return out;
}

/**
 * Share of In Review exits that went to Done, against back to In Progress.
 * Sent back once, then Done, is 1 of 2: 0.5. Null when nothing left review.
 */
export function reviewPassRate(tickets: KpiTicket[]): number | null {
  let passed = 0;
  let sentBack = 0;
  for (const t of tickets) {
    t.stays.forEach((s, i) => {
      if (s.column !== "in_review" || s.synthetic) return;
      const next = t.stays[i + 1]?.column;
      if (next === "done") passed++;
      else if (next === "in_progress") sentBack++;
    });
  }
  const exits = passed + sentBack;
  return exits === 0 ? null : passed / exits;
}

/** Milliseconds from first entering To Do to reaching Done; null if either is missing. */
export function leadTime(t: KpiTicket): number | null {
  const start = firstEntry(t, "todo") ?? firstEntry(t, "backlog");
  const end = doneAt(t);
  return start && end ? Math.max(0, end.getTime() - start.getTime()) : null;
}

/** Milliseconds from first entering In Progress to reaching Done. */
export function cycleTime(t: KpiTicket): number | null {
  const start = firstEntry(t, "in_progress");
  const end = doneAt(t);
  return start && end ? Math.max(0, end.getTime() - start.getTime()) : null;
}

export function averageLeadTime(tickets: KpiTicket[]): number | null {
  return mean(tickets.map(leadTime).filter((v): v is number => v !== null));
}

export function averageCycleTime(tickets: KpiTicket[]): number | null {
  return mean(tickets.map(cycleTime).filter((v): v is number => v !== null));
}

/** Tickets reaching Done per week over the span from the first Done to now (at least one week). */
export function throughputPerWeek(tickets: KpiTicket[], now: number): number | null {
  const dones = tickets.map(doneAt).filter((d): d is Date => d !== null);
  if (dones.length === 0) return null;
  const first = Math.min(...dones.map((d) => d.getTime()));
  const weeks = Math.max(1, (now - first) / WEEK_MS);
  return dones.length / weeks;
}

/** Share of tickets that ended blocked or failed; null for no tickets. */
export function blockedFailedRate(tickets: KpiTicket[]): number | null {
  return tickets.length === 0 ? null : tickets.filter((t) => t.blockedOrFailed).length / tickets.length;
}

/** Cost per story point over the estimated tickets; null when there are no points. */
export function costPerStoryPoint(tickets: KpiTicket[]): number | null {
  const estimated = tickets.filter((t) => t.storyPoints !== null && t.storyPoints > 0);
  const points = estimated.reduce((sum, t) => sum + (t.storyPoints ?? 0), 0);
  return points === 0 ? null : estimated.reduce((sum, t) => sum + t.costUsd, 0) / points;
}

export function averageAttempts(tickets: KpiTicket[]): number | null {
  return mean(tickets.map((t) => t.attempts));
}

export function averageScopeRequests(tickets: KpiTicket[]): number | null {
  return mean(tickets.map((t) => t.scopeRequests));
}

/** Precision: tickets done on the first attempt, without a scope request. */
export function precisionCount(tickets: KpiTicket[]): number {
  return tickets.filter((t) => doneAt(t) !== null && t.attempts <= 1 && t.scopeRequests === 0).length;
}

export interface Kpis {
  tickets: number;
  averageTimePerColumn: Record<ColumnId, number | null>;
  reviewPassRate: number | null;
  averageLeadTime: number | null;
  averageCycleTime: number | null;
  throughputPerWeek: number | null;
  blockedFailedRate: number | null;
  costPerStoryPoint: number | null;
  averageAttempts: number | null;
  averageScopeRequests: number | null;
  precisionCount: number;
}

export function computeKpis(all: KpiTicket[], window: KpiWindow, now: number): Kpis {
  const tickets = inWindow(all, window, now);
  return {
    tickets: tickets.length,
    averageTimePerColumn: averageTimePerColumn(tickets, now),
    reviewPassRate: reviewPassRate(tickets),
    averageLeadTime: averageLeadTime(tickets),
    averageCycleTime: averageCycleTime(tickets),
    throughputPerWeek: throughputPerWeek(tickets, now),
    blockedFailedRate: blockedFailedRate(tickets),
    costPerStoryPoint: costPerStoryPoint(tickets),
    averageAttempts: averageAttempts(tickets),
    averageScopeRequests: averageScopeRequests(tickets),
    precisionCount: precisionCount(tickets),
  };
}
