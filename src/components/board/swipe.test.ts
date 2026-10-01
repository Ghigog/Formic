import { describe, expect, it } from "vitest";
import { adjacentColumn, swipeDirection } from "./swipe";

describe("adjacentColumn", () => {
  it("steps through the columns", () => {
    expect(adjacentColumn("backlog", "next")).toBe("todo");
    expect(adjacentColumn("todo", "previous")).toBe("backlog");
  });
  it("clamps at both ends", () => {
    expect(adjacentColumn("backlog", "previous")).toBe("backlog");
    expect(adjacentColumn("done", "next")).toBe("done");
  });
});

describe("swipeDirection", () => {
  it("reads left as next and right as previous", () => {
    expect(swipeDirection(-80, 5)).toBe("next");
    expect(swipeDirection(80, -5)).toBe("previous");
  });
  it("ignores short travel", () => {
    expect(swipeDirection(-49, 0)).toBeNull();
  });
  it("ignores a mostly vertical gesture with drift", () => {
    expect(swipeDirection(-60, 120)).toBeNull();
    expect(swipeDirection(60, 40)).toBeNull();
  });
});
