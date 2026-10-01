export interface TokenWindowSettings {
  renewalDay: number | null;
  timezone: string | null;
  resetAt: Date | null;
}

export interface TokenWindow {
  since: Date | null;
  kind: "renewal" | "reset" | "all-time";
}

interface Local {
  year: number;
  month: number; // 1-12
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** The wall-clock fields of an instant in a timezone, as a UTC-epoch number. */
function wallClockMs(instant: number, timezone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

/** The instant at which the wall clock in `timezone` reads midnight on the given date. */
function localMidnight({ year, month, day }: Local, timezone: string): Date {
  const wanted = Date.UTC(year, month - 1, day);
  // Two passes settle the offset even when it differs between the guess and the answer.
  let guess = wanted;
  for (let i = 0; i < 2; i++) guess = wanted - (wallClockMs(guess, timezone) - guess);
  return new Date(guess);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function boundary(year: number, month: number, renewalDay: number, timezone: string): Date {
  const day = Math.min(renewalDay, daysInMonth(year, month));
  return localMidnight({ year, month, day }, timezone);
}

/**
 * Where a person's token count starts. A renewal day wins, then a manual
 * reset, then all time. The renewal boundary is local midnight, in the
 * person's IANA timezone, of the latest renewal day not after `now`; a day
 * past the month's end falls on its last day.
 */
export function tokenWindow(
  { renewalDay, timezone, resetAt }: TokenWindowSettings,
  now: Date,
): TokenWindow {
  if (renewalDay !== null && timezone !== null) {
    const local = new Date(wallClockMs(now.getTime(), timezone));
    let year = local.getUTCFullYear();
    let month = local.getUTCMonth() + 1;
    let since = boundary(year, month, renewalDay, timezone);
    if (since.getTime() > now.getTime()) {
      month -= 1;
      if (month === 0) {
        month = 12;
        year -= 1;
      }
      since = boundary(year, month, renewalDay, timezone);
    }
    return { since, kind: "renewal" };
  }
  if (resetAt) return { since: resetAt, kind: "reset" };
  return { since: null, kind: "all-time" };
}
