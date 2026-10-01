import type { BoardCard } from "@/lib/domain/entities";

export type ColumnSort = "position" | "title" | "newest" | "points";
/** Tickets are the plain ones, with no work type. */
export type TypeFilter = "ticket" | "bug" | "spike" | "archived";

export interface ColumnView {
  query: string;
  sort: ColumnSort;
  /** The toggled-on types. None means every non-archived card. */
  types: TypeFilter[];
  collapsed: boolean;
}

export const EMPTY_VIEW: ColumnView = {
  query: "",
  sort: "position",
  types: [],
  collapsed: false,
};

export function isViewActive(view: ColumnView): boolean {
  return (
    view.query.trim() !== "" ||
    view.sort !== "position" ||
    view.types.length > 0 ||
    view.collapsed
  );
}

export function applyView(cards: BoardCard[], view: ColumnView): BoardCard[] {
  let result = [...cards];

  // 1. Type filter: archived cards only through the Archived toggle
  const { types } = view;
  result = result.filter((card) => {
    if (card.archived) return types.includes("archived");
    return types.length === 0 || types.includes(card.workType ?? "ticket");
  });

  // 2. Query search (case-insensitive over key and title)
  const q = view.query.trim().toLowerCase();
  if (q !== "") {
    result = result.filter((card) => {
      const keyMatch = card.key?.toLowerCase().includes(q) ?? false;
      const titleMatch = card.title?.toLowerCase().includes(q) ?? false;
      return keyMatch || titleMatch;
    });
  }

  // 3. Sort (stable)
  if (view.sort === "title") {
    result.sort((a, b) => a.title.localeCompare(b.title));
  } else if (view.sort === "newest") {
    result.sort((a, b) => {
      const aDate = a.createdAt ? new Date(a.createdAt).getTime() : NaN;
      const bDate = b.createdAt ? new Date(b.createdAt).getTime() : NaN;
      const aHas = !isNaN(aDate);
      const bHas = !isNaN(bDate);
      if (!aHas && !bHas) return 0;
      if (!aHas) return 1; // cards without createdAt sort last
      if (!bHas) return -1;
      return bDate - aDate; // newest first
    });
  } else if (view.sort === "points") {
    result.sort((a, b) => {
      const aPoints = a.storyPoints ?? null;
      const bPoints = b.storyPoints ?? null;
      const aHas = aPoints !== null && aPoints !== undefined;
      const bHas = bPoints !== null && bPoints !== undefined;
      if (!aHas && !bHas) return 0;
      if (!aHas) return 1; // cards without points sort last
      if (!bHas) return -1;
      return (bPoints as number) - (aPoints as number); // highest points first (e.g. 8, 2)
    });
  }
  // 'position' keeps incoming order (stable sort)

  return result;
}

/** The same members, whatever the order. */
export function sameTypes(a: TypeFilter[], b: TypeFilter[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}
