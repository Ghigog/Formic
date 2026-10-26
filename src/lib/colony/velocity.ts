import type { BoardCard } from "@/lib/domain/entities";
import { pointsOf } from "./game";

/** Days back from `at`, today included, that count as recent history. */
export const VELOCITY_WINDOW_DAYS = 28;
/** Fewest days with a merge before the measured pace is trusted. */
export const MIN_ACTIVE_DAYS = 5;

function dayKey(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Median story points merged per active day (a day with a merge) over the
 * recent window ending at `at`, or null when there are fewer than
 * MIN_ACTIVE_DAYS of them. Days without merges are not counted.
 */
export function measureVelocity(cards: BoardCard[], at: Date): number | null {
  const today = dayKey(at);
  const oldest = today - (VELOCITY_WINDOW_DAYS - 1) * 86_400_000;
  const perDay = new Map<number, number>();
  for (const c of cards) {
    if (c.kind !== "ticket" || c.status !== "merged") continue;
    const iso = c.mergedAt ?? c.updatedAt;
    const when = iso ? new Date(iso) : null;
    if (!when || Number.isNaN(when.getTime())) continue;
    const day = dayKey(when);
    if (day < oldest || day > today) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + pointsOf(c));
  }
  if (perDay.size < MIN_ACTIVE_DAYS) return null;
  const sorted = [...perDay.values()].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return median > 0 ? median : null;
}
