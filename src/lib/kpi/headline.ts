import type { ProjectKpis } from "./compute";

const tickets = (n: number) => (n === 1 ? "1 ticket" : `${n} tickets`);

/**
 * One or two short sentences in the ant's voice that sum up the board. It names
 * only numbers that exist, and compares with the 30 days before only when
 * `previous` is there (never for All time).
 */
export function kpiHeadline({
  window,
  tiles,
  previous,
}: Pick<ProjectKpis, "window" | "tiles" | "previous">): string {
  if (tiles.done === 0) {
    return window === "all"
      ? "Nothing has reached Done yet. The colony is still gathering crumbs."
      : "Nothing done this month yet. The colony is still gathering crumbs.";
  }
  let first =
    window === "all"
      ? `${tickets(tiles.done)} done in all`
      : `${tickets(tiles.done)} done this month`;
  if (previous) {
    const diff = tiles.done - previous.done;
    first +=
      diff > 0
        ? `, ${diff} more than last`
        : diff < 0
          ? `, ${-diff} fewer than last`
          : ", the same as last";
  }
  const sentences = [`${first}.`];
  if (tiles.passRate !== null) {
    const tenths = Math.round(tiles.passRate * 10);
    sentences.push(
      tenths >= 10
        ? "Review let every one through first time."
        : `Review let ${tenths} in 10 through first time.`,
    );
  }
  return sentences.join(" ");
}
