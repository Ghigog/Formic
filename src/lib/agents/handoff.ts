/**
 * Steps a ticket needs that happen outside the repository: a secret to set,
 * a command to run on the person's machine, a setting in a service. The
 * agent lists them, the pull request carries them, and the Epic's showcase
 * hands them to the person once everything has merged.
 */

export const MAX_HANDOFF_STEPS = 10;
const MAX_STEP = 500;

/** The steps as an agent sent them, cleaned up. */
export function checkHandoff(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().slice(0, MAX_STEP))
    .filter(Boolean)
    .slice(0, MAX_HANDOFF_STEPS);
}

const HEADER = /^\s*#*\s*for you\s*:?\s*$/i;
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/;

/**
 * The "For you:" section of a CLI agent's summary, one "- step" per line.
 * Empty when there is none.
 */
export function handoffFromSummary(text: string): string[] {
  const { steps } = section(text.split(/\r?\n/));
  return checkHandoff(steps);
}

/** A summary without its "For you:" section, for a pull request body. */
export function withoutHandoff(text: string): string {
  const lines = text.split(/\r?\n/);
  const { start, end } = section(lines);
  if (start === -1) return text;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Where the section is, and its items. */
function section(lines: string[]): { start: number; end: number; steps: string[] } {
  const start = lines.findIndex((l) => HEADER.test(l));
  if (start === -1) return { start, end: start, steps: [] };
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() === "") end++;
  const steps: string[] = [];
  for (; end < lines.length; end++) {
    const m = ITEM.exec(lines[end]!);
    if (!m) break;
    steps.push(m[1]!);
  }
  return { start, end, steps };
}

/** The Markdown section that hands the steps to the person. */
export function handoffSection(steps: Array<{ key: string; steps: string[] }>): string {
  const withSteps = steps.filter((t) => t.steps.length > 0);
  if (withSteps.length === 0) return "";
  return [
    "## For you",
    "",
    "Steps no agent could take. They happen outside the repository, so they are yours:",
    "",
    ...withSteps.flatMap((t) => t.steps.map((s) => `- [ ] ${s} (${t.key})`)),
  ].join("\n");
}
