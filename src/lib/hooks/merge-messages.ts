/**
 * A thread is the newest page, which polling replaces, with the earlier pages
 * the person asked for in front of it. Merging by id means a poll never drops
 * a loaded earlier message and never shows one twice; the newest page wins
 * where both hold the same message (its status and content are fresher).
 * Pages arrive oldest first, so the order is the order of creation.
 */
export function mergeMessages<T extends { id: string }>(earlier: T[], newest: T[]): T[] {
  if (earlier.length === 0) return newest;
  const have = new Set(newest.map((m) => m.id));
  return [...earlier.filter((m) => !have.has(m.id)), ...newest];
}
