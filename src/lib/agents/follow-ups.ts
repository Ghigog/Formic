import { z } from "zod";

import { STORY_POINTS, type StoryPoints } from "@/lib/domain/entities";

/**
 * Work an agent found that does not belong in its ticket: a criterion that
 * needs far more than the ticket's size, or one that waits on other tickets.
 * The agent does the part that fits and proposes the rest here instead of
 * doing it. The person sees each on the ticket and adds it as its own tech
 * debt ticket on the same Epic, or dismisses it.
 */
export interface FollowUp {
  title: string;
  /** What the work is and why it was left out, for the ticket's description. */
  why: string;
  points: StoryPoints | null;
  /** "needed" goes straight onto the board; "nice" asks the person. */
  need: FollowUpNeed;
  /** What became of it. Absent on a legacy follow-up, still answered in the drawer. */
  outcome?: FollowUpOutcome;
}

export type FollowUpNeed = "needed" | "nice";

export type FollowUpOutcome =
  | { kind: "pending" }
  | { kind: "added"; key: string; cardId: string; announced?: boolean }
  | { kind: "proposed"; messageId: string }
  | { kind: "dismissed" };

export const MAX_FOLLOW_UPS = 5;
const MAX_TITLE = 120;
const MAX_WHY = 1_000;

const pointsSchema = z
  .number()
  .refine((n): n is StoryPoints => (STORY_POINTS as readonly number[]).includes(n))
  .nullable()
  .catch(null);

const needSchema = z
  .unknown()
  .optional()
  .transform((v): FollowUpNeed => (v === "needed" ? "needed" : "nice"));

const outcomeSchema = z
  .union([
    z.object({ kind: z.literal("pending") }),
    z.object({ kind: z.literal("added"), key: z.string(), cardId: z.string(), announced: z.boolean().optional() }),
    z.object({ kind: z.literal("proposed"), messageId: z.string() }),
    z.object({ kind: z.literal("dismissed") }),
  ])
  .optional()
  .catch(undefined);

const followUpSchema = z.object({
  title: z.string().transform((s) => s.trim().slice(0, MAX_TITLE)),
  why: z.string().transform((s) => s.trim().slice(0, MAX_WHY)),
  points: pointsSchema.optional().transform((p) => (p ?? null) as StoryPoints | null),
  need: needSchema,
  outcome: outcomeSchema,
});

/** Follow-ups as an agent or the database gave them, cleaned up. */
export function checkFollowUps(raw: unknown): FollowUp[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => followUpSchema.safeParse(item))
    .flatMap((r) => {
      if (!r.success || !r.data.title) return [];
      const { outcome, ...rest } = r.data;
      return [outcome ? { ...rest, outcome } : rest];
    })
    .slice(0, MAX_FOLLOW_UPS);
}

/** What a ticket already had, plus what an agent added, without repeats. */
export function mergeFollowUps(had: FollowUp[], more: FollowUp[] = []): FollowUp[] {
  const seen = new Set(had.map((f) => f.title.toLowerCase()));
  const added = more.filter((f) => {
    const key = f.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...had, ...added].slice(0, MAX_FOLLOW_UPS);
}

const HEADER = /^\s*#*\s*follow-ups?\s*:?\s*$/i;
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/;
/** "[needed] " or "[nice to have] " before the title; the label is optional. */
const LABEL = /^\[\s*(needed|nice(?:\s+to\s+have)?)\s*\]\s*/i;
/** "Title (5 pt): why", with the points optional. */
const LINE = /^(.+?)(?:\s*\((\d+)\s*(?:pts?|points?)\))?\s*:\s+(.+)$/i;

/**
 * The "Follow-ups:" section of a CLI agent's summary, one
 * "- Title (5 pt): why" per line. Empty when there is none.
 */
export function followUpsFromSummary(text: string): FollowUp[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADER.test(l));
  if (start === -1) return [];
  const found: unknown[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "" && found.length === 0) continue;
    const item = ITEM.exec(lines[i]!);
    if (!item) break;
    const label = LABEL.exec(item[1]!);
    const need = label?.[1]!.toLowerCase() === "needed" ? "needed" : "nice";
    const body = label ? item[1]!.slice(label[0].length) : item[1]!;
    const m = LINE.exec(body);
    found.push(
      m
        ? { title: m[1]!, why: m[3]!, points: m[2] ? Number(m[2]) : null, need }
        : { title: body, why: "", points: null, need },
    );
  }
  return checkFollowUps(found);
}

/** The section a summary carries them in, for a commit message. */
export function followUpsSection(followUps: FollowUp[]): string {
  if (followUps.length === 0) return "";
  return [
    "Follow-ups:",
    ...followUps.map((f) => `- [${f.need === "needed" ? "needed" : "nice to have"}] ${f.title}${f.points ? ` (${f.points} pt)` : ""}${f.why ? `: ${f.why}` : ""}`),
  ].join("\n");
}
