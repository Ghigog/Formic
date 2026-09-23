/**
 * Why an agent stopped, read off what it printed.
 *
 * A CLI agent that runs out of its plan, or whose sign-in has lapsed, exits
 * with a one-line reason and a nonzero code. GitHub only reports "failure";
 * the reason is in the log. This turns that log into something a card can
 * say, and, for a usage limit, the moment the agent can work again.
 *
 * No server imports: pure text in, a diagnosis out.
 */

export type Diagnosis =
  | {
      kind: "limit";
      /** When the agent can work again, or null when it did not say. */
      until: Date | null;
      message: string;
    }
  | { kind: "auth" | "credit"; until: null; message: string };

/* ------------------------------------------------------------------------ */
/* Reading the log.                                                          */
/* ------------------------------------------------------------------------ */

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

interface Line {
  text: string;
  at: Date | null;
}

function lines(log: string): Line[] {
  return log.split(/\r?\n/).map((raw) => {
    const m = TIMESTAMP.exec(raw);
    const text = (m ? raw.slice(m[0].length) : raw).replace(ANSI, "").trim();
    return { text, at: m ? new Date(m[1]!) : null };
  });
}

/**
 * What the failing step printed: the lines between its header group and
 * GitHub's "##[error]" marker. The header echoes the step's script and
 * environment, prompt included, and ticket text must never be mistaken for
 * the agent's own words. Plain text with no markers is taken whole.
 */
function stepOutput(log: string): Line[] {
  const all = lines(log);
  if (!all.some((l) => l.text.startsWith("##["))) return all.filter((l) => l.text);
  const end = all.findIndex((l) => l.text.startsWith("##[error]"));
  if (end === -1) return [];
  let start = end;
  while (start > 0 && !all[start - 1]!.text.startsWith("##[endgroup]")) start--;
  return all.slice(start, end).filter((l) => l.text && !l.text.startsWith("##["));
}

/** The last thing the agent said before its step failed. */
export function lastWords(log: string): string | null {
  const text = stepOutput(log).at(-1)?.text;
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/* ------------------------------------------------------------------------ */
/* Clock times in a named zone.                                              */
/* ------------------------------------------------------------------------ */

/** Minutes the zone is ahead of UTC at that instant. */
function zoneOffset(zone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

function validZone(zone: string | undefined): string {
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** The instant a wall-clock time in a zone falls on. */
function inZone(zone: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffset(zone, new Date(guess)) * 60_000;
  return new Date(guess - zoneOffset(zone, new Date(first)) * 60_000);
}

/** Today's date in a zone. */
function dateIn(zone: string, at: Date): { y: number; mo: number; d: number } {
  const local = new Date(at.getTime() + zoneOffset(zone, at) * 60_000);
  return { y: local.getUTCFullYear(), mo: local.getUTCMonth(), d: local.getUTCDate() };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "resets 6:30pm (UTC)", "resets Oct 2, 5pm (America/New_York)",
 * "try again at 9:14 AM": the next moment that clock time comes round.
 */
function nextClockTime(text: string, now: Date): Date | null {
  const m =
    /(?:resets?|try again at|available at)\s+(?:(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!m) return null;
  const [, mon, day, year, hour, minute, meridiem, zoneName] = m;
  let h = Number(hour);
  if (meridiem) {
    if (h > 12) return null;
    h = (h % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  } else if (!minute) {
    // A bare number is too ambiguous to count down to.
    return null;
  }
  if (h > 23) return null;
  const mi = Number(minute ?? 0);
  const zone = validZone(zoneName?.trim());
  const today = dateIn(zone, now);

  if (mon && day) {
    const mo = MONTHS.indexOf(mon.toLowerCase());
    if (mo === -1) return null;
    let y = year ? Number(year) : today.y;
    let at = inZone(zone, y, mo, Number(day), h, mi);
    // "Jan 2" read in late December is next year's.
    if (!year && at.getTime() < now.getTime() - 86_400_000) {
      y += 1;
      at = inZone(zone, y, mo, Number(day), h, mi);
    }
    return at;
  }

  let at = inZone(zone, today.y, today.mo, today.d, h, mi);
  if (at.getTime() <= now.getTime()) at = inZone(zone, today.y, today.mo, today.d + 1, h, mi);
  return at;
}

/** "try again in 4 days 3 hours 20 minutes", "retry in 23.4s", "in 2h 30m". */
function afterDuration(text: string, now: Date): Date | null {
  const m = /(?:try again|retry|resets?|available)\s+in\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!m) return null;
  let ms = 0;
  for (const [, n, unit] of m[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const u = unit!.toLowerCase();
    const value = Number(n);
    if (/^(d|days?)$/.test(u)) ms += value * 86_400_000;
    else if (/^(h|hrs?|hours?)$/.test(u)) ms += value * 3_600_000;
    else if (/^(m|mins?|minutes?)$/.test(u)) ms += value * 60_000;
    else if (/^(s|secs?|seconds?)$/.test(u)) ms += value * 1_000;
  }
  return ms > 0 ? new Date(now.getTime() + ms) : null;
}

/** Claude Code's older form: "Claude AI usage limit reached|1759262400". */
function epochReset(text: string): Date | null {
  const m = /limit reached\|(\d{9,13})/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return new Date(n < 1e12 ? n * 1000 : n);
}

/* ------------------------------------------------------------------------ */
/* What the line means.                                                      */
/* ------------------------------------------------------------------------ */

const LIMIT =
  /(hit your (?:session |weekly |daily |usage |5-hour |monthly )?limit|usage limit|(?:session|weekly|daily|5-hour|opus|sonnet) limit reached|limit reached\||rate.?limit(?:ed)?|quota exceeded|exhausted your|resource_exhausted|too many requests|\b429\b)/i;
const CREDIT =
  /(credit balance is too low|insufficient[_ ]quota|out of credits?|billing|payment required|\b402\b)/i;
const AUTH =
  /(invalid api key|invalid (?:x-api-key|bearer token)|authentication[_ ]error|oauth token (?:has )?expired|token (?:has )?expired|please run \/login|not logged in|unauthori[sz]ed|\b401\b|api key not valid|permission denied|invalid_grant)/i;

/** How a person fixes a rejected sign-in for each CLI. */
function signInHelp(label: string): string {
  if (/claude/i.test(label)) return "Run `claude setup-token`, then paste the new token into the agent.";
  if (/codex/i.test(label)) return "Sign in to Codex again, then paste the new auth.json or key into the agent.";
  return "Paste a new key into the agent.";
}

/** "6:30 PM UTC", as a stored message says it. The board counts down live. */
export function formatReset(at: Date): string {
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at)} UTC`;
}

/**
 * What an agent's failure means, from the text it printed.
 *
 * `label` names the agent ("Claude Code"). `now` is only a fallback: a line
 * with a timestamp is read against its own time, so a log collected late
 * still resolves "resets 6:30pm" to the right day.
 */
export function diagnose(text: string, label: string, now = new Date()): Diagnosis | null {
  const all = stepOutput(text);
  // The agent's own words sit at the end; read from there.
  for (let i = all.length - 1; i >= 0; i--) {
    const { text: line, at } = all[i]!;
    const when = at ?? now;
    const quoted = `"${line.length > 200 ? `${line.slice(0, 200)}…` : line}"`;

    if (CREDIT.test(line)) {
      return {
        kind: "credit",
        until: null,
        message: `${label} is out of credit: ${quoted} Top the account up, or switch this column to an agent on another account.`,
      };
    }
    if (LIMIT.test(line)) {
      const until = epochReset(line) ?? nextClockTime(line, when) ?? afterDuration(line, when);
      return {
        kind: "limit",
        until,
        message: until
          ? `${label} hit its usage limit: ${quoted} It can work again at ${formatReset(until)}. Move the card back then, or switch this column to an agent on another account.`
          : `${label} hit its usage limit: ${quoted} Try again later, or switch this column to an agent on another account.`,
      };
    }
    if (AUTH.test(line)) {
      return {
        kind: "auth",
        until: null,
        message: `${label} rejected its sign-in: ${quoted} ${signInHelp(label)}`,
      };
    }
  }
  return null;
}

/**
 * What an API provider's error means. `retryAfter` is the response's
 * Retry-After header, in seconds or as a date.
 */
export function describeProviderError(input: {
  label: string;
  status: number | null;
  message: string;
  retryAfter?: string | null;
  now?: Date;
}): string {
  const { label, status, message } = input;
  const now = input.now ?? new Date();
  const detail = message.replace(/\s+/g, " ").trim().slice(0, 300);

  if (status === 401 || status === 403 || AUTH.test(detail)) {
    return `${label} rejected the API key. Edit the agent and paste a valid one.`;
  }
  if (status === 402 || CREDIT.test(detail)) {
    return `${label} is out of credit. Top the account up, or switch this column to an agent on another account.`;
  }
  if (status === 429 || LIMIT.test(detail)) {
    const wait = retryAfterDate(input.retryAfter ?? null, now);
    return wait
      ? `${label} is rate limiting this key until ${formatReset(wait)}. Move the card back after that.`
      : `${label} is rate limiting this key. Wait a minute, then move the card back to retry.`;
  }
  if (status === 529 || status === 503 || /overloaded/i.test(detail)) {
    return `${label} is overloaded right now. Move the card back in a few minutes to retry.`;
  }
  if (status === null) return `Could not reach ${label}${detail ? `: ${detail}` : "."}`;
  return `${label} error ${status}${detail ? `: ${detail}` : ""}`;
}

function retryAfterDate(value: string | null, now: Date): Date | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(now.getTime() + seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}
