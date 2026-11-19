/**
 * Reads why a step in the sandbox failed, from its last lines, so the screen
 * blames the right side and offers the right help. See docs/plans/playtest.md,
 * "Whose failure it is".
 *
 * - The sandbox's own limits (memory, disk) are Playtest's: no change to the
 *   repository can lift them, so no agent is offered.
 * - Missing configuration (a secret, a database) is neither: Playtest has
 *   none to give, and an agent cannot add the person's secrets either.
 *
 * Anything it does not recognise keeps the fault its step was given.
 */

export type Fault = "project" | "playtest" | "config";

export interface Diagnosis {
  fault: Fault;
  /** One plain sentence on what went wrong, shown above the log. */
  message: string;
}

/** E2B's default sandbox, which is what Playtest runs in. */
export const SANDBOX_MEMORY = "512 MiB";

const MEMORY = /\bKilled\b|exit (?:status |code )?137\b|signal: killed|out of memory|JavaScript heap out of memory|ENOMEM|Cannot allocate memory|std::bad_alloc/i;
const DISK = /No space left on device|ENOSPC|Disk quota exceeded|Failure writing output to destination/i;
const CONFIG = [
  /(?:environment variable|env(?:ironment)? var(?:iable)?)s?\b[^\n]*\b(?:missing|not set|required|undefined|not defined)/i,
  /\b[A-Z][A-Z0-9_]{2,}\b (?:is|was) (?:not set|missing|required|undefined)/,
  /missing required (?:env|environment|configuration|config)/i,
  /ECONNREFUSED[^\n]*:(?:5432|3306|6379|27017)\b/,
  /\b(?:DATABASE_URL|REDIS_URL|MONGODB_URI)\b/,
  /invalid api key|api key (?:is )?(?:missing|required|not set)/i,
];

export function diagnose(lines: readonly string[], why = ""): Diagnosis | null {
  const text = `${lines.join("\n")}\n${why}`;
  if (MEMORY.test(text)) {
    return {
      fault: "playtest",
      message: `The sandbox ran out of memory. E2B's sandbox has ${SANDBOX_MEMORY}, and this step needed more.`,
    };
  }
  if (DISK.test(text)) return { fault: "playtest", message: "The sandbox ran out of disk space." };
  if (CONFIG.some((re) => re.test(text))) {
    return {
      fault: "config",
      message:
        "This app needs configuration Playtest doesn't have: an environment variable, a database or an API key. Playtest has no secrets to give it.",
    };
  }
  return null;
}
