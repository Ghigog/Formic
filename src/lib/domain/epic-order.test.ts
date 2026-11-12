import { describe, expect, it } from "vitest";
import { isRestructure, orderEpics, waitLine, type OrderEpic } from "./epic-order";

const epic = (id: string, tickets: OrderEpic["tickets"]): OrderEpic => ({ id, key: id.toUpperCase(), tickets });
const t = (scope: string[], extra = {}) => ({ fileScope: scope, storyPoints: 3, ...extra });

describe("isRestructure", () => {
  it("needs moveOnly tickets to be at least half the points", () => {
    expect(isRestructure([t(["a"], { moveOnly: true }), t(["a"])])).toBe(true);
    expect(isRestructure([t(["a"], { moveOnly: true }), t(["a"]), t(["a"])])).toBe(false);
    expect(isRestructure([t(["a"])])).toBe(false);
  });
});

describe("orderEpics", () => {
  it("makes a normal new Epic wait for an overlapping one, naming the files", () => {
    const waits = orderEpics(epic("e96", [t(["src/app/layout.tsx"])]), [
      epic("e95", [t(["src/app"])]),
      epic("e90", [t(["docs"])]),
    ]);
    expect(waits).toEqual([
      { epicId: "e96", epicKey: "E96", waitsForId: "e95", waitsForKey: "E95", paths: ["src/app/layout.tsx"] },
    ]);
  });

  it("ignores merged tickets", () => {
    expect(orderEpics(epic("n", [t(["src"])]), [epic("o", [t(["src"], { merged: true })])])).toEqual([]);
  });

  it("lets a new restructure go first", () => {
    const waits = orderEpics(epic("e95", [t(["src/app"], { moveOnly: true })]), [epic("e96", [t(["src/app"])])]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ epicId: "e96", waitsForId: "e95", paths: ["src/app"] });
  });

  it("makes a restructure wait for an earlier restructure", () => {
    const waits = orderEpics(epic("new", [t(["src"], { moveOnly: true })]), [epic("old", [t(["src"], { moveOnly: true })])]);
    expect(waits[0]).toMatchObject({ epicId: "new", waitsForId: "old" });
  });

  it("waits for nothing when nothing overlaps", () => {
    expect(orderEpics(epic("n", [t(["a"])]), [epic("o", [t(["b"])])])).toEqual([]);
  });
});

describe("waitLine", () => {
  it("lists at most five paths", () => {
    const paths = ["a", "b", "c", "d", "e", "f", "g"];
    expect(waitLine({ waitsForKey: "EPIC-95", paths })).toBe("Waits for EPIC-95: both change a, b, c, d, e and 2 more.");
    expect(waitLine({ waitsForKey: "EPIC-95", paths: ["x.ts", "y.ts"] })).toBe("Waits for EPIC-95: both change x.ts, y.ts.");
  });
});
