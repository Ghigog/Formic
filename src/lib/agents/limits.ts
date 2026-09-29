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
 * GitHub's last "##[error]" marker. The header echoes the step's script and
 * environment, prompt included, and ticket text must never be mistaken for
 * the agent's own words. Plain text with no markers is taken whole.
 *
 * The last marker, not the first. A loop streams its output to stderr as it
 * works and GitHub annotates each of those lines as an error, so the first
 * marker can sit in the middle of a run. Reading it as the end of the log cut
 * a real card's evidence off where the agent happened to be typing `tsc`, and
 * the card quoted that banner instead of the reason the run stopped.
 */
function stepOutput(log: string): Line[] {
  const all = lines(log);
  if (!all.some((l) => l.text.startsWith("##["))) return said(all.filter((l) => l.text));
  let end = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.text.startsWith("##[error]")) {
      end = i;
      break;
    }
  }
  if (end === -1) return [];
  let start = end;
  while (start > 0 && !all[start - 1]!.text.startsWith("##[endgroup]")) start--;
  return said(all.slice(start, end).filter((l) => l.text && !l.text.startsWith("##[")));
}

/**
 * Our own streamed envelope: a job reports itself by printing JSON lines.
 * Narrow on purpose — a provider's error body is JSON too, and Anthropic's
 * starts with `{"type":` (`{"type":"error","error":{…}}`), so only the job's
 * own event types are unwrapped, and a provider's words stay its own.
 */
const ENVELOPE = /^\{"type":"(?:run\.|ticket\.)/;

/**
 * The lines a person or a tool wrote. A loop reports itself by printing JSON
 * envelopes to stderr, and what they carry is the interesting part; one that
 * carries no line of output is dropped rather than quoted, so a card can
 * never show `{"type":"run.log",…}` where the agent's words belong.
 */
function said(lines: Line[]): Line[] {
  return lines.flatMap((line) => {
    if (!ENVELOPE.test(line.text)) return [line];
    try {
      const inner = (JSON.parse(line.text) as { line?: unknown }).line;
      return typeof inner === "string" && inner.trim() ? [{ ...line, text: inner.trim() }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Our own line, not the agent's: a job prints the loop entry's reason, then
 * this. Reading it as the last word hides the reason it was printed after,
 * which is the one thing a card has to be able to say.
 */
const PLUMBING = /^The loop stopped \(exit \d+\)\.$/;

/** The job's own account of why its loop stopped. */
const STOP_REASON =
  /^(?:The agent did not converge in \d+ turns?\.|Ran out of time: |Spend ceiling reached\b)/;

/**
 * The last thing the agent said before its step failed.
 *
 * The job's own reason comes first when there is one. A run stopped by a turn
 * ceiling or a budget says why, and at that moment the agent's last words are
 * whatever tool output it was reading — a `wc -l` line count, or the banner of
 * the check it was halfway through — which tells a person nothing about what
 * to do next, and is not even the thing that failed.
 */
export function lastWords(log: string): string | null {
  const spoken = stepOutput(log).filter((l) => l.text && !PLUMBING.test(l.text));
  let reason: string | null = null;
  for (let i = spoken.length - 1; i >= 0 && reason === null; i--) {
    const text = spoken[i]!.text;
    if (STOP_REASON.test(text)) reason = text;
  }
  const text = reason ?? spoken.at(-1)?.text;
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

/**
 * A usage limit, in the words a provider or a CLI uses for one.
 *
 * A bare status code is not one of them. An agent runs the project's own
 * tools, and their output is full of numbers that look like codes: a listing
 * prints "429 src/lib/db/repository-contract.test.ts" — a line count — and a
 * test run can print "402 passing". Reading either as a provider's refusal
 * tells the person their plan is spent and marks the agent out of usage it
 * never used, so a code counts only where the log says it is one: "status
 * code 429", `{"code": 429}`, "error 429".
 *
 * A rate limit is a refusal, not a mention of one, for the same reason: an
 * agent rewriting a test named "Rate-limit the merge queue" printed it, and
 * the card reported a plan out of usage while the account was fine. So the
 * phrase has to be one a provider refuses with — "rate limit exceeded",
 * "rate_limit_error", "Rate Limit Reached" — or the words a person is told
 * with, "hit your rate limit", "too many requests".
 */
const LIMIT =
  /(hit your (?:session |weekly |daily |usage |5-hour |monthly |rate )?limit|usage limit|(?:session|weekly|daily|5-hour|opus|sonnet) limit reached|limit reached\||rate[ _-]?limit(?:s|ed|ing)?[ _-]?(?:error|reached|exceeded|hit|exhausted)|quota exceeded|insufficient[_ ]quota|exhausted your|resource_exhausted|too many requests|(?:http|status|status_?code|error|response|code)\W{0,6}429\b)/i;
/**
 * A balance problem, narrowly read. A quota is an allowance, not a balance,
 * so `insufficient_quota` belongs to LIMIT: proxies report a spent usage
 * window with those exact words, and calling that "out of credit" sends a
 * person to top up an account that is already paid for. The bare word
 * `billing` and the digits `402` are not signals either — both turn up in
 * ordinary log output (a step can print "402 passing") — so only phrases a
 * provider uses about money are matched here. The HTTP status code is the
 * real signal, and it is read first where there is one.
 */
const CREDIT =
  /(credit balance is too low|insufficient (?:credit|credits|balance|funds)|out of credits?|payment required|purchase credits|add (?:a )?payment|no credits? (?:left|remaining))/i;
const AUTH =
  /(invalid api key|invalid (?:x-api-key|bearer token)|authentication[_ ]error|oauth token (?:has )?expired|token (?:has )?expired|please run \/login|not logged in|unauthori[sz]ed|api key not valid|permission denied|invalid_grant|(?:http|status|status_?code|error|response|code)\W{0,6}401\b)/i;

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
  // The status code and the provider's own words both go into every message.
  // The code is the only piece of evidence a person can hand to a provider,
  // and the words are how a wrong guess here gets caught: a proxy that says
  // "insufficient_quota" about a usage window, or a body that mentions
  // billing for some unrelated reason, is visible instead of hidden behind
  // our own sentence about it.
  const code = status === null ? "" : ` (HTTP ${status})`;
  const said = detail ? ` ${label} said: "${detail}"` : "";

  if (status === 401 || status === 403 || AUTH.test(detail)) {
    return `${label} rejected the API key${code}. Edit the agent and paste a valid one.${said}`;
  }
  if (status === 402 || CREDIT.test(detail)) {
    return `${label} is out of credit${code}. Top the account up, or switch this column to an agent on another account.${said}`;
  }
  if (status === 429 || LIMIT.test(detail)) {
    const wait = retryAfterDate(input.retryAfter ?? null, now);
    return wait
      ? `${label} is rate limiting this key${code} until ${formatReset(wait)}. Move the card back after that.${said}`
      : `${label} is rate limiting this key${code}. Wait a minute, then move the card back to retry.${said}`;
  }
  if (status === 529 || status === 503 || /overloaded/i.test(detail)) {
    return `${label} is overloaded right now${code}. Move the card back in a few minutes to retry.${said}`;
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
