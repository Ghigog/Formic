import { describe, expect, it } from "vitest";
import { readiness, type Stackable } from "./stack";

const card = (id: string, status: string, over: Partial<Stackable> = {}): Stackable => ({
  id,
  kind: "ticket",
  status,
  prNumber: status === "review" ? 7 : null,
  dependsOn: [],
  ...over,
});

describe("readiness", () => {
  it("starts from the merge target once everything it depends on has merged", () => {
    const a = card("a", "merged");
    expect(readiness(card("b", "waiting", { dependsOn: ["a"] }), [a])).toEqual({ ready: true, onto: null });
    expect(readiness(card("c", "ready"), [])).toEqual({ ready: true, onto: null });
  });

  it("stacks on the one prerequisite with an open pull request", () => {
    const a = card("a", "review");
    const m = card("m", "merged");
    expect(readiness(card("b", "waiting", { dependsOn: ["a", "m"] }), [a, m])).toEqual({ ready: true, onto: a });
  });

  it("waits on a prerequisite still being written, or with no pull request yet", () => {
    const running = card("a", "running");
    const reviewNoPr = card("r", "review", { prNumber: null });
    expect(readiness(card("b", "waiting", { dependsOn: ["a"] }), [running])).toEqual({ ready: false, waitingOn: [running] });
    expect(readiness(card("b", "waiting", { dependsOn: ["r"] }), [reviewNoPr]).ready).toBe(false);
  });

  it("waits when two prerequisites are open, since a branch has one base", () => {
    const a = card("a", "review");
    const c = card("c", "review");
    expect(readiness(card("b", "waiting", { dependsOn: ["a", "c"] }), [a, c])).toEqual({ ready: false, waitingOn: [a, c] });
  });

  it("waits on a prerequisite it cannot see", () => {
    expect(readiness(card("b", "waiting", { dependsOn: ["gone"] }), []).ready).toBe(false);
  });
});

describe("readiness of a ticket whose Epic waits for another Epic", () => {
  const epic = (id: string, over: Partial<Stackable> = {}): Stackable => ({ ...card(id, "ready", { kind: "epic" }), ...over });
  const waiter = epic("e2", { waitsFor: ["e1"] });
  const ticket = card("t", "ready", { epicId: "e2" });

  it("is not ready while the Epic it waits for is not done", () => {
    const first = epic("e1", { childCount: 2, doneCount: 1 });
    expect(readiness(ticket, [first, waiter, ticket]).ready).toBe(false);
  });

  it("is ready once that Epic is merged, all its tickets merged, or gone", () => {
    expect(readiness(ticket, [epic("e1", { status: "merged" }), waiter, ticket]).ready).toBe(true);
    expect(readiness(ticket, [epic("e1", { childCount: 2, doneCount: 2 }), waiter, ticket]).ready).toBe(true);
    expect(readiness(ticket, [waiter, ticket]).ready).toBe(true);
  });
});
