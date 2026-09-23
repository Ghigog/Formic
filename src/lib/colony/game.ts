import type { BoardCard } from "@/lib/domain/entities";
import { columnFor } from "@/lib/domain/status";

/**
 * The colony's rules: points, levels and the heat multiplier.
 *
 * Everything durable is derived from the board, so a reload or a second
 * browser agrees on the score. The only thing kept on the side is the
 * multiplier each merge earned while someone was watching (the ledger);
 * a merge nobody saw scores at 1×.
 */

/** XP per level. */
export const XP_PER_LEVEL = 50;
/** What reporting a bug costs, in points. Never XP: levels only go up. */
export const BUG_COST = 5;
/** How long one heat stack lasts. */
export const HEAT_WINDOW_MS = 45_000;
/** Most heat stacks at once. */
export const HEAT_MAX = 6;

export const RANKS = [
  "Scout",
  "Forager",
  "Worker",
  "Nurse",
  "Soldier",
  "Architect",
  "Tunneler",
  "Queen’s Guard",
  "Matriarch",
  "Queen",
] as const;

export type BugShape = "beetle" | "ladybird" | "spider" | "moth" | "stag";
export type BugColor = "umber" | "crimson" | "ochre" | "jade" | "anthracite" | "terracotta";

export const SHAPE_UNLOCKS: ReadonlyArray<{ key: BugShape; label: string; lv: number }> = [
  { key: "beetle", label: "Beetle", lv: 1 },
  { key: "ladybird", label: "Ladybird", lv: 3 },
  { key: "spider", label: "Spider", lv: 5 },
  { key: "moth", label: "Moth", lv: 6 },
  { key: "stag", label: "Stag beetle", lv: 8 },
];

export const COLOR_UNLOCKS: ReadonlyArray<{ key: BugColor; label: string; hex: string; lv: number }> = [
  { key: "umber", label: "Umber", hex: "#4A2F22", lv: 1 },
  { key: "crimson", label: "Crimson", hex: "#B3261E", lv: 2 },
  { key: "ochre", label: "Ochre", hex: "#A86A04", lv: 4 },
  { key: "jade", label: "Jade", hex: "#2E6B31", lv: 6 },
  { key: "anthracite", label: "Anthracite", hex: "#1C1917", lv: 7 },
  { key: "terracotta", label: "Terracotta", hex: "#C4561A", lv: 9 },
];

export function levelOf(xp: number): number {
  return Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1;
}

export function rankOf(level: number): string {
  return RANKS[Math.min(Math.max(1, level), RANKS.length) - 1]!;
}

/** What a level unlocks, by label. */
export function unlocksAt(level: number): string[] {
  return [...SHAPE_UNLOCKS, ...COLOR_UNLOCKS].filter((u) => u.lv === level).map((u) => u.label);
}

/** The next level that unlocks anything, and what. Null once all are in. */
export function nextUnlock(level: number): { level: number; labels: string[] } | null {
  const ahead = [...SHAPE_UNLOCKS, ...COLOR_UNLOCKS].filter((u) => u.lv > level);
  if (!ahead.length) return null;
  const lv = Math.min(...ahead.map((u) => u.lv));
  return { level: lv, labels: unlocksAt(lv) };
}

const BUG_WORDS = /\b(bug|bugs|fix|fixes|broken|crash|crashes|flicker|flickers|error|errors|wrong|fail|fails)\b/i;

/** A request that reads as a bug report. Words, not a field: the domain has no type. */
export function isBugText(text: string): boolean {
  return BUG_WORDS.test(text);
}

/**
 * A card that is a bug: its own title says so. Tickets an architect wrote
 * for a bug epic are ordinary work and do not count again.
 */
export function isBug(card: BoardCard): boolean {
  if (card.kind === "ticket" && card.epicId) return false;
  return isBugText(card.title);
}

/** A bug that has been handed to the agents. */
export function isSquashed(card: BoardCard): boolean {
  return columnFor(card.status, card.stalledIn) !== "backlog";
}

/** Story points a ticket is worth. Unestimated work counts as 1. */
export function pointsOf(card: BoardCard): number {
  return card.storyPoints ?? 1;
}

/** What one merge earned while someone watched: its points and multiplier. */
export interface LedgerEntry {
  pts: number;
  mult: number;
  /** Epoch ms. */
  at: number;
}

export type Ledger = Record<string, LedgerEntry>;

/** An epic's completion bonus: the story points of everything it merged. */
export function epicBonus(epic: BoardCard, cards: BoardCard[]): number {
  return cards
    .filter((c) => c.kind === "ticket" && c.epicId === epic.id)
    .reduce((n, c) => n + pointsOf(c), 0);
}

/** A merged ticket's points: as recorded, or at 1× if nobody saw it land. */
export function mergePoints(card: BoardCard, ledger: Ledger): number {
  return ledger[card.id]?.pts ?? pointsOf(card);
}

export interface Score {
  /** XP: every point ever earned. Drives the level. */
  earned: number;
  /** Earned less bug penalties. What the header counts. */
  points: number;
  level: number;
  rank: string;
  /** XP into the current level. */
  intoLevel: number;
  bugs: number;
  squashed: number;
}

export function scoreOf(cards: BoardCard[], ledger: Ledger): Score {
  let earned = 0;
  let bugs = 0;
  let squashed = 0;
  for (const card of cards) {
    if (card.kind === "ticket" && card.status === "merged") earned += mergePoints(card, ledger);
    if (card.kind === "epic" && card.status === "merged") earned += epicBonus(card, cards);
    if (isBug(card)) {
      bugs++;
      if (isSquashed(card)) squashed++;
    }
  }
  const level = levelOf(earned);
  return {
    earned,
    points: Math.max(0, earned - bugs * BUG_COST),
    level,
    rank: rankOf(level),
    intoLevel: earned % XP_PER_LEVEL,
    bugs,
    squashed,
  };
}

/** Heat stacks still alive at `now`. Each is its expiry time. */
export function liveStacks(stacks: number[], now: number): number[] {
  return stacks.filter((t) => t > now).sort((a, b) => a - b);
}

export function multiplierOf(stackCount: number): number {
  return 1 + 0.5 * stackCount;
}

/**
 * One merge against the current heat: what it scores, and the stacks after
 * it adds its own. The oldest stack drops when the pile is full.
 */
export function heatMerge(
  storyPoints: number,
  stacks: number[],
  now: number,
): { pts: number; mult: number; stacks: number[] } {
  const live = liveStacks(stacks, now);
  const mult = multiplierOf(live.length);
  const next = [...live, now + HEAT_WINDOW_MS];
  while (next.length > HEAT_MAX) next.shift();
  return { pts: Math.round(storyPoints * mult), mult, stacks: next };
}

/** Grade for points per story point merged. */
export const GRADES: ReadonlyArray<{ min: number; grade: "S" | "A" | "B" | "C"; color: string }> = [
  { min: 2.5, grade: "S", color: "#C27803" },
  { min: 2, grade: "A", color: "#2E7D32" },
  { min: 1.5, grade: "B", color: "#57534E" },
  { min: 0, grade: "C", color: "#C62828" },
];

export function gradeOf(yieldRatio: number) {
  return GRADES.find((g) => yieldRatio >= g.min) ?? GRADES[GRADES.length - 1]!;
}
