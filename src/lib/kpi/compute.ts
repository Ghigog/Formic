import type { TicketChange, TicketColumnEntry } from "@/lib/db/repository";
import { COLUMNS, type ColumnId } from "@/lib/domain/status";

export type KpiWindow = "30d" | "all";

const DAY = 86_400_000;
const ms = (iso: string) => new Date(iso).getTime();

export interface TimelineEntry {
  column: ColumnId;
  enteredAt: string;
  exitedAt: string | null;
  /** Milliseconds in the column; null for a synthetic entry, which stands in for lost history. */
  durationMs: number | null;
}

/** A ticket's stays in columns, each with how long it lasted (an open one runs to `now`). */
export function timeline(entries: TicketColumnEntry[], now: Date): TimelineEntry[] {
  return entries.map((e) => ({
    column: e.column,
    enteredAt: e.enteredAt,
    exitedAt: e.exitedAt,
    durationMs: e.synthetic ? null : Math.max(0, (e.exitedAt ? ms(e.exitedAt) : now.getTime()) - ms(e.enteredAt)),
  }));
}

/**
 * Share of leaves from In Review that went on rather than back to an earlier
 * column. Null when nothing has left review yet.
 */
export function passRate(entries: TicketColumnEntry[]): number | null {
  let left = 0;
  let passed = 0;
  entries.forEach((e, i) => {
    const next = entries[i + 1];
    if (e.column !== "in_review" || !next) return;
    left++;
    if (COLUMNS.indexOf(next.column) > COLUMNS.indexOf(e.column)) passed++;
  });
  return left ? passed / left : null;
}

/** A ticket is precise when nothing about it changed after it was specified. */
export function precision(changes: TicketChange[]): { changes: number; precise: boolean } {
  return { changes: changes.length, precise: changes.length === 0 };
}

export interface TicketHistory {
  entries: TicketColumnEntry[];
  changes: TicketChange[];
}

export interface ProjectKpis {
  window: KpiWindow;
  tiles: {
    done: number;
    inFlight: number;
    /** Median days from first leaving the backlog to reaching Done; null with none. */
    cycleTimeDays: number | null;
    passRate: number | null;
    precision: number | null;
  };
  /** Average days a ticket spends in each column. */
  timeInColumn: Record<ColumnId, number | null>;
  /** Tickets reaching Done per day, oldest first. */
  throughput: Array<{ date: string; done: number }>;
  cycleTime: Array<{ doneAt: string; days: number }>;
  /** Per day tickets reached Done, oldest first: mean review pass rate (null with no review) and share of precise tickets. */
  quality: Array<{ date: string; passRate: number | null; precision: number }>;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export function projectKpis(histories: TicketHistory[], window: KpiWindow, now: Date): ProjectKpis {
  const from = window === "30d" ? now.getTime() - 30 * DAY : -Infinity;
  const sums = Object.fromEntries(COLUMNS.map((c) => [c, { total: 0, n: 0 }])) as Record<ColumnId, { total: number; n: number }>;
  const perDay = new Map<string, number>();
  const cycle: Array<{ doneAt: string; days: number }> = [];
  const rates: number[] = [];
  const doneByDay = new Map<string, Array<{ rate: number | null; precise: boolean }>>();
  let done = 0;
  let inFlight = 0;
  let precise = 0;
  let considered = 0;

  for (const { entries, changes } of histories) {
    const last = entries.at(-1);
    if (!last) continue;
    if (last.column === "in_progress" || last.column === "in_review") inFlight++;
    for (const t of timeline(entries, now)) {
      if (t.durationMs === null || ms(t.enteredAt) < from) continue;
      sums[t.column].total += t.durationMs;
      sums[t.column].n++;
    }
    const doneEntry = entries.find((e) => e.column === "done");
    if (doneEntry && ms(doneEntry.enteredAt) >= from) {
      done++;
      perDay.set(day(ms(doneEntry.enteredAt)), (perDay.get(day(ms(doneEntry.enteredAt))) ?? 0) + 1);
      const key = day(ms(doneEntry.enteredAt));
      doneByDay.set(key, [...(doneByDay.get(key) ?? []), { rate: passRate(entries), precise: changes.length === 0 }]);
      const started = entries.find((e) => e.column !== "backlog" && !e.synthetic);
      if (started) cycle.push({ doneAt: doneEntry.enteredAt, days: Math.max(0, ms(doneEntry.enteredAt) - ms(started.enteredAt)) / DAY });
    }
    const rate = passRate(entries.filter((e) => ms(e.enteredAt) >= from));
    if (rate !== null) rates.push(rate);
    if (ms(last.enteredAt) >= from || changes.length) {
      considered++;
      if (changes.length === 0) precise++;
    }
  }

  cycle.sort((a, b) => a.doneAt.localeCompare(b.doneAt));
  const sorted = cycle.map((c) => c.days).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = !sorted.length ? null : sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    window,
    tiles: {
      done,
      inFlight,
      cycleTimeDays: median,
      passRate: mean(rates),
      precision: considered ? precise / considered : null,
    },
    timeInColumn: Object.fromEntries(
      COLUMNS.map((c) => [c, sums[c].n ? sums[c].total / sums[c].n / DAY : null]),
    ) as ProjectKpis["timeInColumn"],
    throughput: [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, n]) => ({ date, done: n })),
    cycleTime: cycle,
    quality: [...doneByDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, ts]) => ({
        date,
        passRate: mean(ts.flatMap((t) => (t.rate === null ? [] : [t.rate]))),
        precision: ts.filter((t) => t.precise).length / ts.length,
      })),
  };
}
