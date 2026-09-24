import { describe, expect, it } from "vitest";
import { flatten, layout, placeDrop } from "./placement";
import { makeCard, makeEpicWithChildren } from "@/test/cards";
import type { BoardCard } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";
import { byPosition } from "@/lib/ordering";

const none = new Set<string>();

/** The keys a column renders top to bottom after the card lands. */
function renderedAfter(
  cards: BoardCard[],
  column: ColumnId,
  moved: BoardCard,
  index: number,
  collapsed: ReadonlySet<string> = none,
): string[] {
  const sorted = [...cards].sort(byPosition);
  const { position, detached } = placeDrop({
    card: moved,
    destination: sorted,
    column,
    collapsed,
    index,
  });
  const next = sorted
    .filter((c) => c.id !== moved.id)
    .concat({ ...moved, position, detached })
    .sort(byPosition);
  return flatten(layout(next, column), collapsed).map((e) => e.card.key);
}

describe("layout", () => {
  it("leaves a detached ticket standing on its own", () => {
    const [epic, a, b] = makeEpicWithChildren({ key: "E" }, [
      { key: "A" },
      { key: "B", detached: true },
    ]);
    const items = layout([epic!, a!, b!], "todo");
    expect(items.map((i) => i.kind)).toEqual(["group", "card"]);
  });
});

describe("placeDrop", () => {
  it("pulls a ticket out of its epic when dropped below the group", () => {
    const [epic, a, b] = makeEpicWithChildren({ key: "E" }, [
      { key: "A" },
      { key: "B" },
    ]);
    // Rendered, minus A: E, B. Index 2 is below the whole group.
    const order = renderedAfter([epic!, a!, b!], "todo", a!, 2);
    expect(order).toEqual(["E", "B", "A"]);
  });

  it("pulls a ticket out when dropped below its group mid-column", () => {
    const [epic, a, b] = makeEpicWithChildren({ key: "E" }, [
      { key: "A" },
      { key: "B" },
    ]);
    const t = makeCard({ key: "T" });
    // Rendered, minus A: E, B, T. Index 2 is under the group, above T.
    expect(renderedAfter([epic!, a!, b!, t], "todo", a!, 2)).toEqual([
      "E",
      "B",
      "A",
      "T",
    ]);
  });

  it("pulls a ticket out above its epic", () => {
    const [epic, a] = makeEpicWithChildren({ key: "E" }, [{ key: "A" }]);
    expect(renderedAfter([epic!, a!], "todo", a!, 0)).toEqual(["A", "E"]);
  });

  it("puts a detached ticket back into its epic when dropped inside it", () => {
    const [epic, a, b] = makeEpicWithChildren({ key: "E" }, [
      { key: "A" },
      { key: "B", detached: true },
    ]);
    const cards = [epic!, a!, { ...b!, position: epic!.position + 5000 }];
    // Rendered, minus B: E, A. Index 1 is between the header and A.
    expect(renderedAfter(cards, "todo", cards[2]!, 1)).toEqual(["E", "B", "A"]);
  });

  it("takes a ticket back into an epic whose group is empty", () => {
    const epic = makeCard({ kind: "epic", key: "E", size: null });
    const t = makeCard({ key: "T" });
    const a = makeCard({ key: "A", epicId: epic.id, detached: true });
    // Rendered, minus A: E, T. Index 1 is straight under the header.
    expect(renderedAfter([epic, t, a], "todo", a, 1)).toEqual(["E", "A", "T"]);
  });

  it("reorders siblings within a group", () => {
    const [epic, a, b, c] = makeEpicWithChildren({ key: "E" }, [
      { key: "A" },
      { key: "B" },
      { key: "C" },
    ]);
    // Rendered, minus C: E, A, B. Index 1 is first child.
    expect(renderedAfter([epic!, a!, b!, c!], "todo", c!, 1)).toEqual([
      "E",
      "C",
      "A",
      "B",
    ]);
  });

  it("lands after the whole group when dropped inside someone else's epic", () => {
    const [e1, a] = makeEpicWithChildren({ key: "E1" }, [{ key: "A" }]);
    const [e2, x, y] = makeEpicWithChildren({ key: "E2" }, [
      { key: "X" },
      { key: "Y" },
    ]);
    const cards = [e1!, a!, e2!, x!, y!];
    // Rendered, minus A: E1, E2, X, Y. Index 3 is between X and Y.
    expect(renderedAfter(cards, "todo", a!, 3)).toEqual([
      "E1",
      "E2",
      "X",
      "Y",
      "A",
    ]);
  });

  it("moves an epic past another epic's whole group", () => {
    const [e1, a] = makeEpicWithChildren({ key: "E1" }, [{ key: "A" }]);
    const [e2, x] = makeEpicWithChildren({ key: "E2" }, [{ key: "X" }]);
    // Rendered, minus E1: A, E2, X — E1's own child is still on screen.
    // Index 3 is the very end.
    expect(renderedAfter([e1!, a!, e2!, x!], "todo", e1!, 3)).toEqual([
      "E2",
      "X",
      "E1",
      "A",
    ]);
  });

  // AUD-07: an Epic dragged to To Do and back to Backlog before the
  // Architect Agent finishes still has its tickets — they are in To Do, not
  // in the destination's own cards, which is exactly the shape placeDrop
  // sees here. It has to land as a plain card, not a group with no children
  // to show, or the round trip strands it.
  it("lands an epic back in Backlog as a plain card, tickets and all", () => {
    const epic = makeCard({ kind: "epic", key: "E", size: null, childCount: 4 });
    const idea = makeCard({ key: "RAW-1", position: epic.position + 5000 });
    const result = placeDrop({
      card: epic,
      destination: [idea],
      column: "backlog",
      collapsed: none,
      index: 0,
    });
    const landed = { ...epic, position: result.position };
    expect(layout([landed, idea], "backlog").map((i) => i.kind)).toEqual([
      "card",
      "card",
    ]);
  });

  it("does not open a collapsed epic to take a ticket", () => {
    const [epic, a] = makeEpicWithChildren({ key: "E" }, [{ key: "A" }]);
    const t = makeCard({ key: "T", epicId: epic!.id, detached: true });
    const collapsed = new Set([epic!.id]);
    const result = placeDrop({
      card: t,
      destination: [epic!, a!, t].sort(byPosition),
      column: "todo",
      collapsed,
      index: 1,
    });
    expect(result.detached).toBe(true);
  });

  it("orders by index alone where nothing groups", () => {
    const cards = ["A", "B", "C"].map((key) => makeCard({ key }));
    expect(renderedAfter(cards, "in_progress", cards[0]!, 2)).toEqual([
      "B",
      "C",
      "A",
    ]);
  });

  it("clears the flag in a column that never groups", () => {
    const [epic, a] = makeEpicWithChildren({}, [{ detached: true }]);
    const result = placeDrop({
      card: a!,
      destination: [epic!],
      column: "in_progress",
      collapsed: none,
      index: 0,
    });
    expect(result.detached).toBe(false);
  });

  it("lands at the end of an empty column", () => {
    const card = makeCard();
    const result = placeDrop({
      card,
      destination: [],
      column: "todo",
      collapsed: none,
      index: 0,
    });
    expect(result.position).toBeGreaterThan(0);
    expect(result.detached).toBe(false);
  });
});
