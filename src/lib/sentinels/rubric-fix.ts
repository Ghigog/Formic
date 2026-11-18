import { z } from "zod";

import type { Rubric, RubricCheck } from "@/lib/db/repository";

import { SENTINELS } from "./roster";

/**
 * An agent's note that one rubric check is wrong: impossible to meet, naming
 * the wrong file, outdated. It only flags; the person approves before the
 * Sentinel revises that one check, and `onlyCheckChanged` is the guard that
 * keeps a revision from touching anything else.
 *
 * No server imports: the page and the server share it.
 */
export interface RubricFixFlag {
  /** The Sentinel's roster id. */
  sentinel: string;
  /** The check's id within its rubric: "5b". */
  check: string;
  /** What is wrong with the check. */
  problem: string;
  /** The change the agent suggests. */
  suggestion: string;
}

export const MAX_RUBRIC_FIXES = 5;
const MAX_FIELD = 1_000;

const trimmed = z.string().transform((s) => s.trim().slice(0, MAX_FIELD));

const flagSchema = z.object({
  sentinel: trimmed,
  check: trimmed,
  problem: trimmed,
  suggestion: trimmed,
});

/** Flags as an agent gave them, cleaned up. */
export function checkRubricFixFlags(raw: unknown): RubricFixFlag[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((item) => {
      const r = flagSchema.safeParse(item);
      return r.success && r.data.sentinel && r.data.check && r.data.problem && r.data.suggestion ? [r.data] : [];
    })
    .slice(0, MAX_RUBRIC_FIXES);
}

const HEADER = /^\s*#*\s*rubric\s+fix(?:es)?\s*:?\s*$/i;
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/;
const ARROW = /\s*(?:->|→)\s*/;

/** Every name a Sentinel answers to, longest first so "Nasty Toes" beats "Nasty". */
const NAMES = SENTINELS.flatMap((s) => [
  { name: s.id.toLowerCase(), id: s.id },
  { name: s.who.toLowerCase(), id: s.id },
]).sort((a, b) => b.name.length - a.name.length);

/**
 * The "Rubric fixes:" section of a CLI agent's summary, one
 * "- Collum 5b: what is wrong -> suggested change" per line. A line naming
 * no known Sentinel is dropped. Empty when there is no section.
 */
export function rubricFixesFromSummary(text: string): RubricFixFlag[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADER.test(l));
  if (start === -1) return [];
  const found: unknown[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "" && found.length === 0) continue;
    const item = ITEM.exec(lines[i]!);
    if (!item) break;
    const body = item[1]!;
    const lower = body.toLowerCase();
    const who = NAMES.find((n) => lower.startsWith(n.name) && /\s/.test(body[n.name.length] ?? ""));
    if (!who) continue;
    const m = /^\s*(\S+?):\s+(.+)$/.exec(body.slice(who.name.length));
    if (!m) continue;
    const [problem, ...rest] = m[2]!.split(ARROW);
    found.push({ sentinel: who.id, check: m[1], problem, suggestion: rest.join(" -> ") });
  }
  return checkRubricFixFlags(found);
}

/** The text a revision may replace; the id stays. */
export type CheckRevision = Pick<RubricCheck, "text" | "how" | "command" | "pass">;

/** The rubric with only that check's text, how, command and pass replaced. Throws for an unknown id. */
export function reviseCheck(rubric: Rubric, checkId: string, next: CheckRevision): Rubric {
  if (!rubric.rungs.some((r) => r.checks.some((c) => c.id === checkId))) {
    throw new Error(`No check ${checkId} in this rubric`);
  }
  return {
    ...rubric,
    rungs: rubric.rungs.map((rung) => ({
      ...rung,
      checks: rung.checks.map((c) =>
        c.id === checkId ? { id: c.id, text: next.text, how: next.how, command: next.command, pass: next.pass } : c,
      ),
    })),
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True only when the context, every rung's stars, every other check and every
 * id are the same before and after. The approved check itself may differ.
 */
export function onlyCheckChanged(before: Rubric, after: Rubric, checkId: string): boolean {
  if (before.context !== after.context) return false;
  if (before.rungs.length !== after.rungs.length) return false;
  return before.rungs.every((rung, i) => {
    const other = after.rungs[i]!;
    if (rung.stars !== other.stars || rung.checks.length !== other.checks.length) return false;
    return rung.checks.every((c, j) => {
      const o = other.checks[j]!;
      if (c.id !== o.id) return false;
      return c.id === checkId || same(c, o);
    });
  });
}
