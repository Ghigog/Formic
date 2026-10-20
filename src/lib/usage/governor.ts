import "server-only";

import { repository } from "@/lib/db";
import type { PlatformUsage, PlatformUsageTotals } from "@/lib/db/repository";
import { type VercelDay, type VercelUsage, fetchVercelUsage, vercelConfigured } from "./vercel";

/**
 * Keeps a deployment on Vercel's Hobby plan under its allowance.
 *
 * Hobby has no overage: go past an allowance and the whole account is paused.
 * So Formic counts what it costs the host, per UTC day in the database, and
 * refuses work before the count reaches the allowance rather than after.
 *
 * Three things are counted, one per allowance that has bitten:
 *
 *   requests  every request the proxy sees: Function Invocations and Edge
 *             Requests (1M each). Each is charged twice, once for the proxy
 *             and once for the handler behind it, which are separate
 *             invocations on Vercel.
 *   busyMs    wall-clock time a function is held: Provisioned Memory (360
 *             GB-hours, at 2 GB a function, is 180 function-hours). A request
 *             is charged a flat REQUEST_BUSY_MS; an event stream and an agent
 *             run in the background are timed.
 *   cpuMs     CPU the process spent, from process.cpuUsage(): Active CPU
 *             (4 hours).
 *
 * The allowances are measured over Vercel's billing period. Read from Vercel
 * (below), the budget uses that period too; otherwise a rolling 30 days, so
 * whatever day the period starts on, Formic never spends more than its share
 * in any 30 days. A daily cap keeps one busy day from spending the month and
 * leaving the board shut for weeks after.
 *
 * Checked against Vercel's own meter (src/lib/usage/vercel.ts) when
 * FORMIC_VERCEL_TOKEN is set: once a day, and whenever Formic's count says a
 * line is near, at most every CONFIRM_EVERY_MS. Vercel's figures replace the
 * count for every day but the last two, which it may not have finished
 * metering, and scale the count for those two by how far the count ran from
 * Vercel's figures over the days before. So a count that runs high stops
 * shutting the board early, and one that runs low stops letting it run late.
 *
 * Two lines:
 *
 *   heavy    at HEAVY_AT of a budget, work that starts more work stops:
 *            changes through the API (which start agents) and the event
 *            stream. Reading the board still works.
 *   stopped  at the budget, every request but the health check is refused
 *            until the next UTC day.
 *
 * Counts are buffered in each instance and written in one statement every
 * FLUSH_EVERY_MS or FLUSH_AT_REQUESTS, so the counting costs about one query
 * per instance every few seconds, not one per request.
 *
 * On by default on Vercel (VERCEL is set); FORMIC_USAGE_LIMITS=on|off overrides.
 * FORMIC_USAGE_SHARE (0 to 1, default 0.7) is the share of each Hobby
 * allowance to budget, leaving headroom for what Formic cannot see.
 * FORMIC_USAGE_BOOST and FORMIC_USAGE_BOOST_UNTIL: see boost().
 */

/** Vercel Hobby's allowances, per 30 days. */
export const HOBBY = {
  invocations: 1_000_000,
  functionHours: 360 / 2,
  cpuHours: 4,
} as const;

export const WINDOW_DAYS = 30;
/** A day may spend this share of the 30-day budget: three average days' worth. */
export const DAILY_SHARE = 0.1;
/** Share of a budget at which work that starts more work is refused. */
export const HEAVY_AT = 0.85;
/** What one request is charged in function time; most take far less. */
export const REQUEST_BUSY_MS = 500;
const DEFAULT_SHARE = 0.7;
const FLUSH_EVERY_MS = 10_000;
const FLUSH_AT_REQUESTS = 25;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How often Vercel is asked while a line is near, and how often an instance rereads the last answer. */
export const CONFIRM_EVERY_MS = 15 * 60_000;
/** How often Vercel is asked when nothing is near. */
export const CHECK_EVERY_MS = DAY_MS;
/** Days of both counts compared to learn how far Formic's runs from Vercel's. */
const CALIBRATION_DAYS = 7;

export type Standing = "ok" | "heavy" | "stopped";

export interface Verdict {
  standing: Standing;
  /** The largest share of any budget used, today's or the window's. */
  used: number;
  /** Seconds until the next UTC day, when a refusal is worth retrying. */
  retryAfter: number;
}

export function governorEnabled(): boolean {
  const v = process.env.FORMIC_USAGE_LIMITS?.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  if (v === "on" || v === "1" || v === "true") return true;
  return !!process.env.VERCEL;
}

/** Whether the board's event stream should poll rather than hold a function open. */
export function shortLivedStreams(): boolean {
  const v = process.env.FORMIC_EVENTS?.trim().toLowerCase();
  if (v === "poll") return true;
  if (v === "stream") return false;
  return !!process.env.VERCEL;
}

/**
 * How often a background check driven by a watched board may run. The
 * checks (finished runs, open pull requests, idle cards) are the fallback
 * behind GitHub's webhooks, and each costs queries and CPU, so on a
 * serverless host, where CPU is the allowance that runs out first, they
 * run at most every SERVERLESS_SWEEP_MS.
 */
export const SERVERLESS_SWEEP_MS = 120_000;
export function sweepInterval(ms: number): number {
  return shortLivedStreams() ? Math.max(ms, SERVERLESS_SWEEP_MS) : ms;
}

function share(): number {
  const n = Number(process.env.FORMIC_USAGE_SHARE);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_SHARE;
}

/**
 * A temporary raise Vercel gives the Hobby allowances now and then (3x until
 * 2026-11-07, granted October 2026): FORMIC_USAGE_BOOST=3 with
 * FORMIC_USAGE_BOOST_UNTIL=2026-11-07. It applies before that UTC day only,
 * so it lapses on its own.
 *
 * Once it has lapsed, remove both variables from the deployment's
 * environment (Vercel > Settings > Environment Variables) and the matching
 * rows from docs/vercel.md if they name the dates; /api/health warns until
 * the variables are gone (boostLapsed). The code stays for the next one.
 */
export function boost(now = Date.now()): number {
  const until = boostUntil();
  const n = Number(process.env.FORMIC_USAGE_BOOST);
  if (!until || !Number.isFinite(n) || n <= 1) return 1;
  return utcDay(now) < until ? n : 1;
}

function boostUntil(): string | null {
  const v = process.env.FORMIC_USAGE_BOOST_UNTIL?.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Whether a boost is still configured after its last day. */
export function boostLapsed(now = Date.now()): boolean {
  const until = boostUntil();
  return !!process.env.FORMIC_USAGE_BOOST?.trim() && !!until && utcDay(now) >= until;
}

export function windowBudget(now = Date.now()): PlatformUsage {
  const s = share() * boost(now);
  return {
    requests: (HOBBY.invocations / 2) * s,
    busyMs: HOBBY.functionHours * HOUR_MS * s,
    cpuMs: HOBBY.cpuHours * HOUR_MS * s,
  };
}

/** The same budget in Vercel's units, to judge its figures by. */
function vercelBudget(now: number): VercelDay {
  const s = share() * boost(now);
  return {
    invocations: HOBBY.invocations * s,
    memoryGbHours: HOBBY.functionHours * 2 * s,
    cpuHours: HOBBY.cpuHours * s,
  };
}

export function dailyBudget(now = Date.now()): PlatformUsage {
  const w = windowBudget(now);
  return {
    requests: w.requests * DAILY_SHARE,
    busyMs: w.busyMs * DAILY_SHARE,
    cpuMs: w.cpuMs * DAILY_SHARE,
  };
}

const KEYS = ["requests", "busyMs", "cpuMs"] as const;
type Key = (typeof KEYS)[number];
/** Which of Vercel's figures each count stands for. */
const VERCEL_KEY: Record<Key, keyof VercelDay> = {
  requests: "invocations",
  busyMs: "memoryGbHours",
  cpuMs: "cpuHours",
};

/** The share of its budget the heaviest metric has used. */
export function usedShare(totals: PlatformUsageTotals, now = Date.now()): number {
  const w = windowBudget(now);
  const d = dailyBudget(now);
  return Math.max(
    ...KEYS.map((k) => totals.window[k] / w[k]),
    ...KEYS.map((k) => totals.today[k] / d[k]),
  );
}

/** What Vercel's meter says, with the counts per day it was set against. */
interface Reading {
  usage: VercelUsage;
  checkedAt: number;
  local: Record<string, PlatformUsage>;
}

/**
 * How far Formic's count of each metric runs from Vercel's, as Vercel's
 * figure over the count, from the days both have finished. 1 where there is
 * nothing to compare.
 */
export function calibration(r: Reading, now: number): Record<Key, number> {
  const w = windowBudget(now);
  const v = vercelBudget(now);
  const out = { requests: 1, busyMs: 1, cpuMs: 1 };
  for (const k of KEYS) {
    let vercel = 0;
    let local = 0;
    for (let i = 2; i < 2 + CALIBRATION_DAYS; i++) {
      const d = utcDay(r.checkedAt - i * DAY_MS);
      const vd = r.usage.days[d];
      const ld = r.local[d];
      if (!vd || !ld) continue;
      vercel += vd[VERCEL_KEY[k]] / v[VERCEL_KEY[k]];
      local += ld[k] / w[k];
    }
    // A day or two of almost nothing says little either way.
    if (vercel > 0.001 && local > 0.001) out[k] = Math.min(20, Math.max(0.05, vercel / local));
  }
  return out;
}

/**
 * The share of its budget the heaviest metric has used, with Vercel's
 * figures standing in for the count where it has them (see the top).
 */
function correctedShare(r: Reading, today: PlatformUsage, since: string, now: number): number {
  const w = windowBudget(now);
  const d = dailyBudget(now);
  const v = vercelBudget(now);
  const factor = calibration(r, now);
  // Days Vercel had finished metering when it was read. A reading that is
  // days old leaves more days to the count.
  const metered = utcDay(r.checkedAt - DAY_MS);
  const days = new Set([...Object.keys(r.usage.days), ...Object.keys(r.local), utcDay(now)]);
  let used = 0;
  for (const k of KEYS) {
    const vk = VERCEL_KEY[k];
    let window = 0;
    for (const day of days) {
      if (day < since || day > utcDay(now)) continue;
      const vercel = (r.usage.days[day]?.[vk] ?? 0) / v[vk];
      if (day < metered) {
        window += vercel;
        continue;
      }
      const counted = day === utcDay(now) ? today[k] : (r.local[day]?.[k] ?? 0);
      window += Math.max(vercel, (counted / w[k]) * factor[k]);
    }
    used = Math.max(used, window, (today[k] * factor[k]) / d[k]);
  }
  return used;
}

/** The first day the budget's window covers: Vercel's billing period when it is known, else 30 days back. */
export function windowStart(now = Date.now()): string {
  const period = reading?.usage.period;
  const today = utcDay(now);
  if (period && period.start <= today && today < period.end) return period.start;
  return utcDay(now - (WINDOW_DAYS - 1) * DAY_MS);
}

export function standingOf(used: number): Standing {
  if (used >= 1) return "stopped";
  if (used >= HEAVY_AT) return "heavy";
  return "ok";
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function secondsToNextUtcDay(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - now) / 1000));
}

/* Per-instance state. */

const zero = (): PlatformUsage => ({ requests: 0, busyMs: 0, cpuMs: 0 });
let pending = zero();
let known: PlatformUsageTotals | null = null;
let knownDay = "";
let lastFlush = 0;
let lastCpu = process.cpuUsage();
let flushing: Promise<void> | null = null;
let failedAt = 0;
let reading: Reading | null = null;
let readAt = 0;
let reloading: Promise<void> | null = null;
let checkFailedAt = 0;

/**
 * Writes this instance's counts on a timer while it runs. Started once per
 * server process (src/instrumentation.ts), so the CPU a route handler spends
 * is counted even in an instance the proxy never runs in.
 */
let clock: ReturnType<typeof setInterval> | null = null;
export function startUsageClock(): void {
  if (clock || !governorEnabled()) return;
  clock = setInterval(() => void flush(false), FLUSH_EVERY_MS);
  clock.unref?.();
}

/** Counts one request through the proxy. */
export function countRequest(): void {
  if (!governorEnabled()) return;
  pending.requests += 2;
  pending.busyMs += REQUEST_BUSY_MS;
}

/**
 * Starts timing work that holds a function: an event stream, a run kept
 * alive with `after()`. Call what it returns when the work ends.
 */
export function holdFunction(): () => Promise<void> {
  if (!governorEnabled()) return async () => {};
  const start = Date.now();
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    pending.busyMs += Date.now() - start;
    await flush(false);
  };
}

/**
 * Where usage stands, writing what this instance has counted when it is due.
 * Never throws: if the count can't be written the request goes ahead, since
 * a database that is down has stopped the board anyway.
 */
export async function verdict(now = Date.now()): Promise<Verdict> {
  const retryAfter = secondsToNextUtcDay(now);
  if (!governorEnabled()) return { standing: "ok", used: 0, retryAfter };
  await flush(false, now);
  if (!known || knownDay !== utcDay(now)) {
    return { standing: "ok", used: 0, retryAfter };
  }
  // What this instance has counted since is added, so a burst between writes
  // can't run past the line.
  const today = add(known.today, pending);
  const counted = usedShare({ today, window: add(known.window, pending) }, now);
  // Near a line by the count: ask Vercel before refusing anything.
  await refreshReading(now, standingOf(counted) !== "ok");
  const used = reading ? correctedShare(reading, today, windowStart(now), now) : counted;
  return { standing: standingOf(used), used, retryAfter };
}

/**
 * Keeps `reading` current: rereads the stored one every CONFIRM_EVERY_MS,
 * and asks Vercel when it is a day old, or CONFIRM_EVERY_MS old while
 * `near`. Waits for Vercel only when `near`; a daily check runs behind the
 * request. Never throws: without Vercel the count stands alone.
 */
async function refreshReading(now: number, near: boolean): Promise<void> {
  if (!vercelConfigured()) return;
  if (reloading) {
    if (near) await reloading;
    return;
  }
  const stale = now - readAt >= CONFIRM_EVERY_MS;
  const age = reading ? now - reading.checkedAt : Infinity;
  const due = age >= CHECK_EVERY_MS || (near && age >= CONFIRM_EVERY_MS);
  if (!stale && !due) return;
  if (!stale && now - checkFailedAt < CONFIRM_EVERY_MS) return;
  reloading = reload(now, near).finally(() => {
    reloading = null;
  });
  if (near) await reloading;
}

async function reload(now: number, near: boolean): Promise<void> {
  const repo = repository();
  const since = utcDay(now - (WINDOW_DAYS + CALIBRATION_DAYS) * DAY_MS);
  try {
    readAt = now;
    const stored = await repo.hostUsageCheck();
    let usage = stored?.data as VercelUsage | undefined;
    let checkedAt = stored?.checkedAt.getTime() ?? 0;
    const age = now - checkedAt;
    if ((age >= CHECK_EVERY_MS || (near && age >= CONFIRM_EVERY_MS)) && now - checkFailedAt >= CONFIRM_EVERY_MS) {
      try {
        usage = await fetchVercelUsage(since, now);
        checkedAt = now;
        await repo.saveHostUsageCheck({ checkedAt: new Date(now), data: usage });
      } catch (e) {
        checkFailedAt = now;
        console.warn("[formic] could not read usage from Vercel:", e);
      }
    }
    if (!usage?.days) return;
    reading = { usage, checkedAt, local: await repo.platformUsageByDay(since) };
  } catch (e) {
    console.warn("[formic] could not load the last Vercel usage reading:", e);
  }
}

/** The totals last read, with what this instance has counted since. For /api/health. */
export async function usageReport(now = Date.now()): Promise<{
  enabled: boolean;
  used: number;
  standing: Standing;
  /** The count alone, before Vercel's figures correct it. */
  countedUsed: number;
  windowStart: string;
  boost: number;
  today: PlatformUsage;
  window: PlatformUsage;
  dailyBudget: PlatformUsage;
  windowBudget: PlatformUsage;
  vercel: {
    checkedAt: string;
    period: VercelUsage["period"];
    units: VercelUsage["units"];
    /** Vercel's figure over Formic's count, per metric. */
    calibration: Record<Key, number>;
    /** Vercel's figures over the window. */
    window: VercelDay;
  } | null;
} | { enabled: false }> {
  if (!governorEnabled()) return { enabled: false };
  await flush(true, now);
  await refreshReading(now, true);
  const totals = known ?? { today: zero(), window: zero() };
  const since = windowStart(now);
  const countedUsed = usedShare(totals, now);
  const used = reading ? correctedShare(reading, totals.today, since, now) : countedUsed;
  return {
    enabled: true,
    used: round(used, 3),
    standing: standingOf(used),
    countedUsed: round(countedUsed, 3),
    windowStart: since,
    boost: boost(now),
    today: rounded(totals.today),
    window: rounded(totals.window),
    dailyBudget: rounded(dailyBudget(now)),
    windowBudget: rounded(windowBudget(now)),
    vercel: reading
      ? {
          checkedAt: new Date(reading.checkedAt).toISOString(),
          period: reading.usage.period,
          units: reading.usage.units,
          calibration: mapKeys(calibration(reading, now), (n) => round(n, 3)),
          window: vercelWindow(reading.usage, since),
        }
      : null,
  };
}

function vercelWindow(usage: VercelUsage, since: string): VercelDay {
  const out: VercelDay = { cpuHours: 0, invocations: 0, memoryGbHours: 0 };
  for (const [d, u] of Object.entries(usage.days)) {
    if (d < since) continue;
    out.cpuHours += u.cpuHours;
    out.invocations += u.invocations;
    out.memoryGbHours += u.memoryGbHours;
  }
  return { cpuHours: round(out.cpuHours, 2), invocations: round(out.invocations), memoryGbHours: round(out.memoryGbHours, 1) };
}

function mapKeys<T>(o: Record<Key, T>, f: (v: T) => T): Record<Key, T> {
  return { requests: f(o.requests), busyMs: f(o.busyMs), cpuMs: f(o.cpuMs) };
}

async function flush(force: boolean, now = Date.now()): Promise<void> {
  if (flushing) return flushing;
  const due =
    force ||
    !known ||
    knownDay !== utcDay(now) ||
    now - lastFlush >= FLUSH_EVERY_MS ||
    pending.requests >= FLUSH_AT_REQUESTS;
  // A database that refused the last write is not asked again on every request.
  if (!due || (!force && now - failedAt < FLUSH_EVERY_MS)) return;

  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  const delta = add(pending, { requests: 0, busyMs: 0, cpuMs: (cpu.user + cpu.system) / 1000 });
  pending = zero();
  lastFlush = now;

  const day = utcDay(now);
  const since = windowStart(now);
  flushing = repository()
    .addPlatformUsage(day, delta, since)
    .then((totals) => {
      known = totals;
      knownDay = day;
    })
    .catch((e: unknown) => {
      // Counted again on the next write rather than lost.
      pending = add(pending, delta);
      failedAt = Date.now();
      console.warn("[formic] could not record host usage:", e);
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

function add(a: PlatformUsage, b: PlatformUsage): PlatformUsage {
  return { requests: a.requests + b.requests, busyMs: a.busyMs + b.busyMs, cpuMs: a.cpuMs + b.cpuMs };
}

function round(n: number, places = 0): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function rounded(u: PlatformUsage): PlatformUsage {
  return { requests: round(u.requests), busyMs: round(u.busyMs), cpuMs: round(u.cpuMs) };
}

/** For tests: forgets everything this instance has counted. */
export function resetGovernorForTests(): void {
  pending = zero();
  known = null;
  knownDay = "";
  lastFlush = 0;
  lastCpu = process.cpuUsage();
  flushing = null;
  failedAt = 0;
  reading = null;
  readAt = 0;
  reloading = null;
  checkFailedAt = 0;
}
