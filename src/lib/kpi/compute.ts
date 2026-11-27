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

/** A ticket is unchanged after spec when nothing about it changed after it was specified. */
export function precision(changes: TicketChange[]): { changes: number; precise: boolean } {
  return { changes: changes.length, precise: changes.length === 0 };
}

export interface TicketRef {
  id: string;
  key: string;
  title: string;
}

export interface TicketHistory {
  ticket: TicketRef & { storyPoints: number | null; costCents: number; attempts: number };
  entries: TicketColumnEntry[];
  changes: TicketChange[];
}

export interface TimeInColumn {
  avgMs: number;
  totalMs: number;
  tickets: number;
}

export interface Tiles {
  done: number;
  inFlight: number;
  /** Median days from first leaving the backlog to reaching Done; null with none. */
  cycleTimeDays: number | null;
  passRate: number | null;
  /** Share of tickets with no change after they were specified; null with none. */
  unchangedAfterSpec: number | null;
  /** Cents spent per story point, over tickets done in the window with points; null with none. */
  costPerPointCents: number | null;
  /** Share of tickets done in the window that never needed a fix attempt; null with none. */
  firstTryRate: number | null;
}

export interface Records {
  bestWeek: { count: number; weekStart: string; achievedAt: string } | null;
  longestRun: { days: number; endsOn: string } | null;
  fastestTicket: { ticket: TicketRef; days: number; doneAt: string } | null;
}

export interface ProjectKpis {
  window: KpiWindow;
  tiles: Tiles;
  /** The same tiles for the 30 days before a 30d window; null for All time. */
  previous: Tiles | null;
  /**
   * Per column a ticket can leave: the average, over tickets that have left it, of the
   * total time one ticket spent there across all its stays. Null when none has left in
   * the window. Done has none: its stay never ends.
   */
  timeInColumn: Record<Exclude<ColumnId, "done">, TimeInColumn | null>;
  /** Tickets reaching Done per UTC day, oldest first, every day of the window included. */
  throughput: Array<{ date: string; done: number; tickets: TicketRef[] }>;
  cycleTime: Array<{ doneAt: string; days: number; ticket: TicketRef }>;
  /** Per day tickets reached Done, oldest first: the mean pass rate (null with no review) and share unchanged after spec of those tickets. */
  quality: Array<{ date: string; passRate: number | null; unchangedAfterSpec: number; done: number; tickets: TicketRef[] }>;
  /** Over all time, whatever the window. */
  records: Records;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const ref = ({ id, key, title }: TicketRef): TicketRef => ({ id, key, title });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

interface Doneish {
  h: TicketHistory;
  doneAt: string;
  startedAt: string | null;
}

/** Tickets with a real (not synthetic) Done, with when work started. */
function realDones(histories: TicketHistory[]): Doneish[] {
  const out: Doneish[] = [];
  for (const h of histories) {
    const d = h.entries.find((e) => e.column === "done");
    if (!d || d.synthetic) continue;
    const started = h.entries.find((e) => e.column !== "backlog" && !e.synthetic);
    out.push({ h, doneAt: d.enteredAt, startedAt: started?.enteredAt ?? null });
  }
  return out;
}

function mondayOf(t: number): string {
  const d = new Date(t);
  const back = (d.getUTCDay() + 6) % 7;
  return day(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
}

export function records(histories: TicketHistory[]): Records {
  const dones = realDones(histories).sort((a, b) => a.doneAt.localeCompare(b.doneAt));
  const weeks = new Map<string, { count: number; last: string }>();
  for (const d of dones) {
    const w = mondayOf(ms(d.doneAt));
    const cur = weeks.get(w) ?? { count: 0, last: d.doneAt };
    weeks.set(w, { count: cur.count + 1, last: d.doneAt });
  }
  let bestWeek: Records["bestWeek"] = null;
  for (const [weekStart, { count, last }] of [...weeks].sort(([a], [b]) => a.localeCompare(b))) {
    if (!bestWeek || count > bestWeek.count) bestWeek = { count, weekStart, achievedAt: last };
  }
  const days = [...new Set(dones.map((d) => day(ms(d.doneAt))))];
  let longestRun: Records["longestRun"] = null;
  let run = 0;
  days.forEach((d, i) => {
    run = i > 0 && ms(`${d}T00:00:00Z`) - ms(`${days[i - 1]}T00:00:00Z`) === DAY ? run + 1 : 1;
    if (!longestRun || run > longestRun.days) longestRun = { days: run, endsOn: d };
  });
  let fastestTicket: Records["fastestTicket"] = null;
  for (const d of dones) {
    if (!d.startedAt) continue;
    const dur = Math.max(0, ms(d.doneAt) - ms(d.startedAt)) / DAY;
    if (!fastestTicket || dur < fastestTicket.days) fastestTicket = { ticket: ref(d.h.ticket), days: dur, doneAt: d.doneAt };
  }
  return { bestWeek, longestRun, fastestTicket };
}

/** Everything the window shows for the range [from, to). */
function rangeKpis(histories: TicketHistory[], window: KpiWindow, from: number, to: number, now: Date) {
  const inRange = (t: number) => t >= from && t < to;
  const sums = Object.fromEntries(COLUMNS.map((c) => [c, { total: 0, n: 0 }])) as Record<ColumnId, { total: number; n: number }>;
  const perDay = new Map<string, TicketRef[]>();
  const cycle: ProjectKpis["cycleTime"] = [];
  const rates: number[] = [];
  const doneByDay = new Map<string, Array<{ ref: TicketRef; rate: number | null; precise: boolean }>>();
  const counted: TicketHistory["ticket"][] = [];
  let inFlight = 0;
  let precise = 0;
  let considered = 0;

  for (const { ticket, entries, changes } of histories) {
    const last = entries.at(-1);
    if (!last) continue;
    if (to === Infinity) {
      if (last.column === "in_progress" || last.column === "in_review") inFlight++;
    } else if (entries.some((e) => (e.column === "in_progress" || e.column === "in_review") && ms(e.enteredAt) <= to && (e.exitedAt === null || ms(e.exitedAt) > to))) {
      inFlight++;
    }
    // One ticket's stays in a column add up; only stays that ended count, so a parked ticket doesn't inflate it.
    const perColumn = new Map<ColumnId, number>();
    for (const t of timeline(entries, now)) {
      if (t.durationMs === null || t.exitedAt === null || !inRange(ms(t.enteredAt))) continue;
      perColumn.set(t.column, (perColumn.get(t.column) ?? 0) + t.durationMs);
    }
    for (const [column, total] of perColumn) {
      sums[column].total += total;
      sums[column].n++;
    }
    const doneEntry = entries.find((e) => e.column === "done");
    const realDone = doneEntry && !doneEntry.synthetic && inRange(ms(doneEntry.enteredAt));
    // A synthetic Done has a guessed date: it counts in All time only, never when or how fast.
    if (doneEntry && (window === "all" || realDone)) counted.push(ticket);
    if (doneEntry && realDone) {
      const key = day(ms(doneEntry.enteredAt));
      perDay.set(key, [...(perDay.get(key) ?? []), ref(ticket)]);
      doneByDay.set(key, [...(doneByDay.get(key) ?? []), { ref: ref(ticket), rate: passRate(entries), precise: changes.length === 0 }]);
      const started = entries.find((e) => e.column !== "backlog" && !e.synthetic);
      if (started) cycle.push({ doneAt: doneEntry.enteredAt, days: Math.max(0, ms(doneEntry.enteredAt) - ms(started.enteredAt)) / DAY, ticket: ref(ticket) });
    }
    const rate = passRate(entries.filter((e) => inRange(ms(e.enteredAt))));
    if (rate !== null) rates.push(rate);
    if (entries.some((e) => !e.synthetic && inRange(ms(e.enteredAt)))) {
      considered++;
      if (changes.length === 0) precise++;
    }
  }

  cycle.sort((a, b) => a.doneAt.localeCompare(b.doneAt));
  const sorted = cycle.map((c) => c.days).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = !sorted.length ? null : sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const pointed = counted.filter((t) => (t.storyPoints ?? 0) > 0);
  const points = pointed.reduce((a, t) => a + (t.storyPoints ?? 0), 0);

  const tiles: Tiles = {
    done: counted.length,
    inFlight,
    cycleTimeDays: median,
    passRate: mean(rates),
    unchangedAfterSpec: considered ? precise / considered : null,
    costPerPointCents: points ? pointed.reduce((a, t) => a + t.costCents, 0) / points : null,
    firstTryRate: counted.length ? counted.filter((t) => t.attempts === 0).length / counted.length : null,
  };
  return { tiles, sums, perDay, cycle, doneByDay };
}

export function projectKpis(histories: TicketHistory[], window: KpiWindow, now: Date): ProjectKpis {
  const from = window === "30d" ? now.getTime() - 30 * DAY : -Infinity;
  const cur = rangeKpis(histories, window, from, Infinity, now);
  const previous = window === "30d" ? rangeKpis(histories, window, from - 30 * DAY, from, now).tiles : null;

  const today = day(now.getTime());
  const firstDone = [...cur.perDay.keys()].sort()[0];
  const startDay = window === "30d" ? day(now.getTime() - 29 * DAY) : firstDone;
  const throughput: ProjectKpis["throughput"] = [];
  if (startDay) {
    for (let t = ms(`${startDay}T00:00:00Z`); day(t) <= today; t += DAY) {
      const tickets = cur.perDay.get(day(t)) ?? [];
      throughput.push({ date: day(t), done: tickets.length, tickets });
    }
  }

  return {
    window,
    tiles: cur.tiles,
    previous,
    timeInColumn: Object.fromEntries(
      COLUMNS.filter((c) => c !== "done").map((c) => [
        c,
        cur.sums[c].n ? { avgMs: cur.sums[c].total / cur.sums[c].n, totalMs: cur.sums[c].total, tickets: cur.sums[c].n } : null,
      ]),
    ) as ProjectKpis["timeInColumn"],
    throughput,
    cycleTime: cur.cycle,
    quality: [...cur.doneByDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, ts]) => ({
        date,
        passRate: mean(ts.flatMap((t) => (t.rate === null ? [] : [t.rate]))),
        unchangedAfterSpec: ts.filter((t) => t.precise).length / ts.length,
        done: ts.length,
        tickets: ts.map((t) => t.ref),
      })),
    records: records(histories),
  };
}
