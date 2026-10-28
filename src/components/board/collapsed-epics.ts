import { COLUMNS, type ColumnId } from "@/lib/domain/status";

/** Versioned so a later change to the shape can start fresh. */
export const COLLAPSED_EPICS_KEY = "formic:collapsed-epics:v1";

export type CollapsedEpics = Record<ColumnId, Set<string>>;

export function emptyCollapsedEpics(): CollapsedEpics {
  return { backlog: new Set(), todo: new Set(), in_progress: new Set(), in_review: new Set(), done: new Set() };
}

/** The collapsed epics saved in this browser; all expanded when missing or unreadable. */
export function loadCollapsedEpics(): CollapsedEpics {
  const out = emptyCollapsedEpics();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_EPICS_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return out;
    const map = parsed as Record<string, unknown>;
    for (const col of COLUMNS) {
      const ids = map[col];
      if (Array.isArray(ids)) out[col] = new Set(ids.filter((id): id is string => typeof id === "string"));
    }
    return out;
  } catch {
    return emptyCollapsedEpics();
  }
}

export function saveCollapsedEpics(collapsed: CollapsedEpics): void {
  try {
    const map: Record<string, string[]> = {};
    for (const col of COLUMNS) map[col] = [...collapsed[col]];
    window.localStorage.setItem(COLLAPSED_EPICS_KEY, JSON.stringify(map));
  } catch {
    // Storage full or blocked: the collapsed epics just won't persist.
  }
}
