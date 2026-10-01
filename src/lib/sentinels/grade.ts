import { SENTINELS, isUnlocked } from "./roster";

/**
 * The project's grade: the average of the unlocked sentinels' stars, where
 * an unlocked sentinel that has not reported counts as zero and a locked one
 * does not count at all. The roster is the same on
 * every project, so grades compare across them.
 */

export type Grade = "S" | "A" | "B" | "C" | "D" | "E" | "F";

/** Best first: each grade and the average it needs. */
export const GRADES: ReadonlyArray<{ grade: Grade; min: number; ink: string }> = [
  { grade: "S", min: 4.5, ink: "var(--clay)" },
  { grade: "A", min: 4.0, ink: "var(--jade)" },
  { grade: "B", min: 3.5, ink: "var(--anthracite)" },
  { grade: "C", min: 3.0, ink: "var(--text-muted)" },
  { grade: "D", min: 2.5, ink: "var(--terracotta-cta)" },
  { grade: "E", min: 2.0, ink: "var(--crimson)" },
  { grade: "F", min: 0, ink: "var(--crimson-chip-text)" },
];

export const GRADE_RULE =
  "Grade = average stars across the unlocked sentinels, unaudited ones counting 0 and locked ones not counted. S ≥ 4.5, A ≥ 4.0, B ≥ 3.5, C ≥ 3.0, D ≥ 2.5, E ≥ 2.0, F below.";

export interface GradeSummary {
  grade: Grade;
  ink: string;
  sum: number;
  avg: number;
  /** Sentinels that have reported. */
  done: number;
  total: number;
  /** The next grade up, and how many more stars reach it. Null at S. */
  next: { grade: Grade; min: number; need: number } | null;
  /** 0..1 of the way from this grade's floor to the next one's. */
  progress: number;
}

export function gradeOf(stars: Record<string, number | null | undefined>, level: number): GradeSummary {
  const unlocked = SENTINELS.filter((s) => isUnlocked(s, level));
  const total = unlocked.length;
  const sum = unlocked.reduce((n, s) => n + (stars[s.id] ?? 0), 0);
  const done = unlocked.filter((s) => stars[s.id] != null).length;
  const avg = total ? sum / total : 0;
  const i = GRADES.findIndex((g) => avg >= g.min - 1e-9);
  const at = GRADES[i]!;
  const up = i > 0 ? GRADES[i - 1]! : null;
  return {
    grade: at.grade,
    ink: at.ink,
    sum,
    avg,
    done,
    total,
    next: up
      ? { grade: up.grade, min: up.min, need: Math.max(1, Math.ceil(up.min * total - sum - 1e-9)) }
      : null,
    progress: up ? Math.min(1, Math.max(0, (avg - at.min) / (up.min - at.min))) : 1,
  };
}

/** Whether `to` is a better grade than `from`. */
export function gradeRose(from: Grade, to: Grade): boolean {
  const order = GRADES.map((g) => g.grade);
  return order.indexOf(to) < order.indexOf(from);
}
