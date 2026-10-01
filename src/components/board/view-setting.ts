import { EMPTY_VIEW, type ColumnSort, type ColumnView, type TypeFilter } from "./view";

/** Versioned so a later change to the shape can start fresh. */
export const BOARD_VIEW_KEY = "formic:board-view:v1";

const SORTS: ColumnSort[] = ["position", "title", "newest", "points"];
const TYPES: TypeFilter[] = ["ticket", "bug", "spike", "archived"];

/** The board-wide view saved in this browser; the default view when missing or unreadable. */
export function loadBoardView(): ColumnView {
  try {
    const raw = window.localStorage.getItem(BOARD_VIEW_KEY);
    if (!raw) return EMPTY_VIEW;
    const parsed: unknown = JSON.parse(raw);
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
