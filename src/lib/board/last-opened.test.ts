import { describe, expect, it } from "vitest";
import { byLastOpened } from "./last-opened";

const at = (n: number) => new Date(Date.UTC(2026, 0, n));

describe("byLastOpened", () => {
  it("puts the most recently opened first and names when each was opened", () => {
    const out = byLastOpened([{ id: "a" }, { id: "b" }, { id: "c" }], new Map([["a", at(2)], ["b", at(3)], ["c", at(1)]]));
    expect(out.map((p) => p.id)).toEqual(["b", "a", "c"]);
    expect(out[0]!.lastOpenedAt).toBe(at(3).toISOString());
  });

  it("keeps never-opened boards after the opened ones, in their given order", () => {
    const out = byLastOpened([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], new Map([["c", at(1)]]));
    expect(out.map((p) => p.id)).toEqual(["c", "a", "b", "d"]);
    expect(out[1]!.lastOpenedAt).toBeNull();
  });
});
