/**
 * Whether a red check's log shows a failure that is not the code's, so
 * running it again is worth a go. Anything else (an assertion, a type or
 * lint error, a build failure) is the code's, and running it again on the
 * same head only repeats it.
 */

/** Tests known to fail on their own. Matched against the log as plain text. */
export const KNOWN_UNRELIABLE_TESTS: string[] = [];

const INFRASTRUCTURE = [
  /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ESOCKETTIMEDOUT)\b/,
  /network (error|timeout|timed out)/i,
  /npm (ERR! )?(code )?(ERR! network|error network)/i,
  /\b(socket hang up|TLS handshake timeout|connection (reset|timed out|refused))\b/i,
  /could not resolve host/i,
  /(error|failed) (fetching|downloading|pulling)\b/i,
  /received a shutdown signal/i,
  /runner .*(lost communication|has received a shutdown)/i,
  /the operation was canceled/i,
  /\bHTTP (5\d\d|429)\b/i,
];

export type RerunVerdict = { rerun: true; reason: string } | { rerun: false };

export function classifyFailure(log: string | null, unreliable: string[] = KNOWN_UNRELIABLE_TESTS): RerunVerdict {
  if (!log) return { rerun: false };
  const infra = INFRASTRUCTURE.find((p) => p.test(log));
  if (infra) return { rerun: true, reason: "the log shows an infrastructure failure" };
  const test = unreliable.find((t) => log.includes(t));
  if (test) return { rerun: true, reason: `${test} is a known-unreliable test` };
  return { rerun: false };
}
