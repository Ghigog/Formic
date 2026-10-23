/**
 * Boards most recently opened first. Boards never opened follow, in the order
 * they came in (creation order), since the sort is stable.
 */
export function byLastOpened<T extends { id: string }>(
  projects: T[],
  openedAt: Map<string, Date>,
): Array<T & { lastOpenedAt: string | null }> {
  return projects
    .map((p) => ({ ...p, lastOpenedAt: openedAt.get(p.id)?.toISOString() ?? null }))
    .sort((a, b) => {
      if (a.lastOpenedAt && b.lastOpenedAt) return a.lastOpenedAt < b.lastOpenedAt ? 1 : a.lastOpenedAt > b.lastOpenedAt ? -1 : 0;
      return a.lastOpenedAt ? -1 : b.lastOpenedAt ? 1 : 0;
    });
}
