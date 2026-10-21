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
}

export const MAX_FOLLOW_UPS = 5;
const MAX_TITLE = 120;
const MAX_WHY = 1_000;

const pointsSchema = z
  .number()
  .refine((n): n is StoryPoints => (STORY_POINTS as readonly number[]).includes(n))
  .nullable()
  .catch(null);

const followUpSchema = z.object({
  title: z.string().transform((s) => s.trim().slice(0, MAX_TITLE)),
  why: z.string().transform((s) => s.trim().slice(0, MAX_WHY)),
  points: pointsSchema.optional().transform((p) => (p ?? null) as StoryPoints | null),
});

/** Follow-ups as an agent or the database gave them, cleaned up. */
export function checkFollowUps(raw: unknown): FollowUp[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => followUpSchema.safeParse(item))
    .flatMap((r) => (r.success && r.data.title ? [r.data] : []))
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
    const m = LINE.exec(item[1]!);
    found.push(
      m
        ? { title: m[1]!, why: m[3]!, points: m[2] ? Number(m[2]) : null }
        : { title: item[1]!, why: "", points: null },
    );
  }
  return checkFollowUps(found);
}

/** The section a summary carries them in, for a commit message. */
export function followUpsSection(followUps: FollowUp[]): string {
  if (followUps.length === 0) return "";
  return [
    "Follow-ups:",
    ...followUps.map((f) => `- ${f.title}${f.points ? ` (${f.points} pt)` : ""}${f.why ? `: ${f.why}` : ""}`),
  ].join("\n");
}
