import type { BoardCard, WorkType } from "@/lib/domain/entities";

export type ColumnSort = "position" | "title" | "newest" | "points";
export type ColumnWorkType = WorkType | null;

export interface ColumnView {
  query: string;
  sort: ColumnSort;
  workType: ColumnWorkType;
  collapsed: boolean;
}

export const EMPTY_VIEW: ColumnView = {
  query: "",
  sort: "position",
  workType: null,
  collapsed: false,
};

export function isViewActive(view: ColumnView): boolean {
  return (
    view.query.trim() !== "" ||
    view.sort !== "position" ||
    view.workType !== null ||
    view.collapsed
  );
}

export function applyView(cards: BoardCard[], view: ColumnView): BoardCard[] {
  let result = [...cards];

  // 1. Work type filter
  if (view.workType !== null) {
    result = result.filter((card) => card.workType === view.workType);
  }

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
