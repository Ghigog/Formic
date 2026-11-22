import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { publish } from "@/lib/events/bus";

/**
 * The lint rules that keep failing on a repository's pull requests.
 *
 * Each card that hits one finds and fixes it on its own, a fix round per pull
 * request. A rule that failed lint on two pull requests is told to the next
 * coder up front. Like shared notes, it is per repository, read across every
 * board on it.
 */

/** How far back a failure counts. */
export const RECURRING_LINT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Distinct pull requests a rule must fail on to be told to coders. */
const RECURRING_AT = 2;

/** The most events read. */
const READ_LIMIT = 1_000;

/** The most rules recorded from one pull request's checks. */
const MAX_RULES = 50;

// Android lint ends a message with its id: "Use the KTX extension [UseKtx]".
const BRACKETED = /\[([A-Z][A-Za-z0-9]{2,})\]\s*$/;
// ESLint, as a message's trailing "(rule)" or after a gap, as in the stylish
// format: "'x' is unused  @typescript-eslint/no-unused-vars". Rule names are
// lower-case, with a dash or a plugin slash, or a known single word.
const ESLINT_RULE = String.raw`@?[a-z][a-z0-9]*(?:[-/][a-z0-9]+)+|[a-z]+`;
const PARENTHESISED = new RegExp(String.raw`\((${ESLINT_RULE})\)\s*$`);
const SPACED = new RegExp(String.raw`\S\s{2,}(${ESLINT_RULE})\s*$`);

/** The rule ids a failing lint check's summary and annotations name, once each. */
export function lintRuleIds(check: {
  summary: string;
  annotations: Array<{ message: string }>;
}): string[] {
  const rules = new Set<string>();
  const lines = [...check.summary.split("\n"), ...check.annotations.flatMap((a) => a.message.split("\n"))];
  for (const raw of lines) {
    const line = raw.trim();
    const bracketed = BRACKETED.exec(line)?.[1];
    if (bracketed) {
      rules.add(bracketed);
      continue;
    }
    const eslint = PARENTHESISED.exec(line)?.[1] ?? SPACED.exec(line)?.[1];
    // A lone lower-case word is only a rule when it is a bare id in
    // parentheses or after a gap; plain prose does not end that way.
    if (eslint) rules.add(eslint);
  }
  return [...rules].slice(0, MAX_RULES);
}

/** Records the rules failing on `prNumber`'s lint checks; nothing when none name a rule. */
export async function recordLintFailures(
  projectId: string,
  ticketId: string,
  prNumber: number,
  checks: Array<{ name: string; summary: string; annotations: Array<{ message: string }> }>,
): Promise<void> {
  const rules = [
    ...new Set(checks.filter((c) => c.name.toLowerCase().includes("lint")).flatMap(lintRuleIds)),
  ].slice(0, MAX_RULES);
  if (rules.length) await publish(projectId, { type: "repo.lint.failed", ticketId, prNumber, rules });
}

export interface RecurringLintRule {
  rule: string;
  /** The distinct pull requests it failed on, ascending. */
  pulls: number[];
}

/** Rules that failed lint on two or more distinct pull requests of `repoFullName` in the last 30 days. */
export async function recurringLint(repoFullName: string, now = Date.now()): Promise<RecurringLintRule[]> {
  const repo = repository();
  const projects = await repo.projectsForRepo(repoFullName);
  if (!projects.length) return [];
  const rows = await repo.eventsOfTypes(
    projects.map((p) => p.id),
    ["repo.lint.failed"],
    new Date(now - RECURRING_LINT_WINDOW_MS),
    READ_LIMIT,
  );
  const seen = new Map<string, Set<number>>();
  for (const row of rows) {
    const event = row.payload as FormicEvent;
    if (event.type !== "repo.lint.failed") continue;
    for (const rule of event.rules) {
      const pulls = seen.get(rule) ?? new Set<number>();
      pulls.add(event.prNumber);
      seen.set(rule, pulls);
    }
  }
  return [...seen]
    .filter(([, pulls]) => pulls.size >= RECURRING_AT)
    .map(([rule, pulls]) => ({ rule, pulls: [...pulls].sort((a, b) => a - b) }));
}

/** The same for a coder's brief, one line per rule: "UseKtx (#723, #724)". */
export async function recurringLintFor(projectId: string): Promise<string[]> {
  const project = await repository().projectById(projectId);
  if (!project) return [];
  return (await recurringLint(project.repoFullName)).map(
    ({ rule, pulls }) => `${rule} (${pulls.map((n) => `#${n}`).join(", ")})`,
  );
}
