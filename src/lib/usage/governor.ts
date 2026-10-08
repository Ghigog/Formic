import "server-only";

import { repository } from "@/lib/db";
import type { PlatformUsage, PlatformUsageTotals } from "@/lib/db/repository";

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
 * The allowances are measured over a rolling 30 days, so the budget is too:
 * whatever day Vercel's own period starts on, Formic never spends more than
 * its share in any 30 days. A daily cap keeps one busy day from spending the
 * month and leaving the board shut for weeks after.
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

export function windowBudget(): PlatformUsage {
  const s = share();
  return {
    requests: (HOBBY.invocations / 2) * s,
    busyMs: HOBBY.functionHours * HOUR_MS * s,
    cpuMs: HOBBY.cpuHours * HOUR_MS * s,
  };
}

export function dailyBudget(): PlatformUsage {
  const w = windowBudget();
  return {
    requests: w.requests * DAILY_SHARE,
    busyMs: w.busyMs * DAILY_SHARE,
    cpuMs: w.cpuMs * DAILY_SHARE,
  };
}

/** The share of its budget the heaviest metric has used. */
export function usedShare(totals: PlatformUsageTotals): number {
  const w = windowBudget();
  const d = dailyBudget();
  const keys = ["requests", "busyMs", "cpuMs"] as const;
  return Math.max(
    ...keys.map((k) => totals.window[k] / w[k]),
    ...keys.map((k) => totals.today[k] / d[k]),
  );
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
  const used = usedShare({
    today: add(known.today, pending),
    window: add(known.window, pending),
  });
  return { standing: standingOf(used), used, retryAfter };
}

/** The totals last read, with what this instance has counted since. For /api/health. */
export async function usageReport(now = Date.now()): Promise<{
  enabled: boolean;
  used: number;
  standing: Standing;
  today: PlatformUsage;
  window: PlatformUsage;
  dailyBudget: PlatformUsage;
  windowBudget: PlatformUsage;
} | { enabled: false }> {
  if (!governorEnabled()) return { enabled: false };
  await flush(true, now);
  const totals = known ?? { today: zero(), window: zero() };
  const used = usedShare(totals);
  return {
    enabled: true,
    used: round(used, 3),
    standing: standingOf(used),
    today: rounded(totals.today),
    window: rounded(totals.window),
    dailyBudget: rounded(dailyBudget()),
    windowBudget: rounded(windowBudget()),
  };
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
  const since = utcDay(now - (WINDOW_DAYS - 1) * 24 * HOUR_MS);
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
}
