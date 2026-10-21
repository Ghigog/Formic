import { COLUMNS, type ColumnId } from "@/lib/domain/status";
import { EMPTY_VIEW, type ColumnSort, type ColumnView, type TypeFilter } from "./view";

/** Versioned so a later change to the shape can start fresh. */
export const BOARD_VIEW_KEY = "formic:board-view:v1";

/** Each column's own view, keyed by ColumnId. */
export const COLUMN_VIEWS_KEY = "formic:column-views:v1";

const SORTS: ColumnSort[] = ["position", "title", "newest", "points"];
const TYPES: TypeFilter[] = ["ticket", "user_story", "task", "feature", "bug", "spike", "archived"];

/** Checks each field of a stored view; anything unreadable falls back to the default. */
function parseView(parsed: unknown): ColumnView {
  if (typeof parsed !== "object" || parsed === null) return EMPTY_VIEW;
  const p = parsed as Record<string, unknown>;
  return {
    query: typeof p.query === "string" ? p.query : EMPTY_VIEW.query,
    sort: SORTS.includes(p.sort as ColumnSort) ? (p.sort as ColumnSort) : EMPTY_VIEW.sort,
    types: Array.isArray(p.types)
      ? TYPES.filter((t) => (p.types as unknown[]).includes(t))
      : EMPTY_VIEW.types,
    collapsed: p.collapsed === true,
  };
}

/** The board-wide view saved in this browser; the default view when missing or unreadable. */
export function loadBoardView(): ColumnView {
  try {
    const raw = window.localStorage.getItem(BOARD_VIEW_KEY);
    return raw ? parseView(JSON.parse(raw)) : EMPTY_VIEW;
  } catch {
    return EMPTY_VIEW;
  }
}

export function saveBoardView(view: ColumnView): void {
  try {
    window.localStorage.setItem(BOARD_VIEW_KEY, JSON.stringify(view));
  } catch {
    // Storage full or blocked: the view just won't persist.
  }
}

/** The views saved per column in this browser; columns with none saved are absent. */
export function loadColumnViews(): Partial<Record<ColumnId, ColumnView>> {
  try {
    const raw = window.localStorage.getItem(COLUMN_VIEWS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const map = parsed as Record<string, unknown>;
    const views: Partial<Record<ColumnId, ColumnView>> = {};
    for (const col of COLUMNS) {
      if (col in map) views[col] = parseView(map[col]);
    }
    return views;
  } catch {
    return {};
  }
}

export function saveColumnViews(views: Record<ColumnId, ColumnView>): void {
  try {
    window.localStorage.setItem(COLUMN_VIEWS_KEY, JSON.stringify(views));
  } catch {
    // Storage full or blocked: the views just won't persist.
  }
}
