import { describe, expect, it } from "vitest";
import { createSwapHistory } from "./swap-order";

const board = (target: string) => ({ kind: "board", target });
const end = { kind: "end" };

describe("createSwapHistory", () => {
  it("goes back to the most recently opened other board before any swap", () => {
    const h = createSwapHistory<string>();
    expect(h.target("up", ["A", "D", "B"], "A")).toEqual(board("D"));
  });

  it("goes to the next board on the list", () => {
    const h = createSwapHistory<string>();
    expect(h.target("down", ["A", "D", "B"], "A")).toEqual(board("D"));
  });

  it("retraces next-next with back-back", () => {
    const order = ["A", "D", "B"];
    const h = createSwapHistory<string>();
    h.target("down", order, "A");
    h.arrived("down", "A");
    expect(h.target("down", order, "D")).toEqual(board("B"));
    h.arrived("down", "D");
    expect(h.target("up", order, "B")).toEqual(board("D"));
    h.arrived("up", "B");
    expect(h.target("up", order, "D")).toEqual(board("A"));
  });

  it("walks further back and never ping-pongs", () => {
    const order = ["3", "2", "1"];
    const h = createSwapHistory<string>();
    expect(h.target("up", order, "3")).toEqual(board("2"));
    h.arrived("up", "3");
    expect(h.target("up", order, "2")).toEqual(board("1"));
    h.arrived("up", "2");
    expect(h.target("up", order, "1")).toEqual(end);
  });

  it("bounces with nothing to go back to and past the end of the list", () => {
    const h = createSwapHistory<string>();
    expect(h.target("up", ["A"], "A")).toEqual(end);
    expect(h.target("down", ["A"], "A")).toEqual(end);
  });

  it("is seeded once: a later order does not reseed it", () => {
    const h = createSwapHistory<string>();
    h.target("up", ["A", "B"], "A");
    expect(h.target("up", ["A", "C"], "A")).toEqual(board("B"));
  });

  it("leaves the history alone when a swap does not arrive", () => {
    const order = ["A", "B"];
    const h = createSwapHistory<string>();
    h.target("down", order, "A");
    expect(h.target("up", order, "A")).toEqual(board("B"));
  });
});
