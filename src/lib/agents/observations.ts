/**
 * Keeping tool output lean, in two places.
 *
 * On the way in, `tidyOutput` drops what a terminal draws but a model only
 * pays for: colour codes, progress bars redrawn with carriage returns, and the
 * same line printed over and over.
 *
 * Later, `staleObservations` picks the tool results an agent has moved past,
 * so the loop can swap them for a one-line placeholder (observation masking).
 * The agent keeps its own reasoning and every call it made; only the bulky
 * outputs go, and it can run any of them again. Results are masked in batches
 * rather than one a turn: each mask rewrites the cached prompt from the first
 * masked result onward, so it is done rarely and only when enough is cleared
 * to pay for it.
 */

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Identical lines in a row past this many collapse to one and a count. */
const REPEAT_RUN = 3;

/** Strips colour codes and redraws, and collapses repeated lines. */
export function tidyOutput(text: string): string {
  const lines = text
    .replace(ANSI, "")
    .split("\n")
    // A carriage return redraws the line: only what was drawn last is seen.
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      const at = trimmed.lastIndexOf("\r");
      return at === -1 ? trimmed : trimmed.slice(at + 1);
    });

  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run > REPEAT_RUN && lines[i]!.trim() !== "") {
      out.push(lines[i]!, `[previous line repeated ${run - 1} more times]`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join("\n");
}

/** A tool result as the loop sent it. */
export interface Observation {
  id: string;
  /** The tool that produced it, for the placeholder. */
  tool: string;
  /** The loop iteration it was sent on. */
  turn: number;
  /** Its length in characters, as sent. */
  size: number;
  masked: boolean;
}

/** Results from this many latest turns stay whole: the agent is working from them. */
export const KEEP_RECENT_TURNS = 3;
/** Results shorter than this cost less than the placeholder is worth. */
export const MASK_MIN_CHARS = 1_000;
/**
 * How much stale output must pile up before a batch is masked: about 12k
 * tokens. Below it, rewriting the cache costs more than clearing saves.
 */
export const MASK_BATCH_CHARS = 48_000;

/**
 * The results to mask after `turn`: every large result older than the recent
 * turns, once together they come to a batch. Empty until then.
 */
export function staleObservations(log: readonly Observation[], turn: number): Observation[] {
  const stale = log.filter(
    (o) => !o.masked && o.size >= MASK_MIN_CHARS && turn - o.turn >= KEEP_RECENT_TURNS,
  );
  const total = stale.reduce((sum, o) => sum + o.size, 0);
  return total >= MASK_BATCH_CHARS ? stale : [];
}

/** What a masked result is replaced with. */
export function maskedNote(o: Observation): string {
  return `[Output of an earlier ${o.tool} (${o.size.toLocaleString("en-US")} characters) cleared to keep the context lean. Run it again if you still need it.]`;
}
