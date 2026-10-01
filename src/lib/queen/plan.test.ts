import { describe, expect, it } from "vitest";
import { makeCard, makeEpicWithChildren } from "@/test/cards";
import { planQueen } from "./plan";

function board() {
  const [epic, a, b] = makeEpicWithChildren({}, [{ status: "ready" }, { status: "waiting" }]);
  b!.dependsOn = [a!.id];
  return { epic: epic!, a: a!, b: b! };
}

describe("planQueen", () => {
  it("queues only the first of two chained tickets", () => {
    const { epic, a, b } = board();
    expect(planQueen([epic, a, b], epic)).toEqual([a.id]);
  });

  it("queues the next once the first is merged", () => {
    const { epic, a, b } = board();
    a.status = "merged";
    expect(planQueen([epic, a, b], epic)).toEqual([b.id]);
  });

  it("queues nothing while a prerequisite is running", () => {
    const { epic, a, b } = board();
    a.status = "running";
    expect(planQueen([epic, a, b], epic)).toEqual([]);
  });

  it("queues nothing when a prerequisite failed or is blocked", () => {
    for (const status of ["failed", "blocked"] as const) {
      const { epic, a, b } = board();
      const c = makeCard({ epicId: epic.id, status: "ready" });
      a.status = status;
      expect(planQueen([epic, a, b, c], epic)).toEqual([]);
    }
  });

  it("includes dependencies outside the epic for a ticket target", () => {
    const dep = makeCard({ status: "ready" });
    const t = makeCard({ status: "waiting", dependsOn: [dep.id] });
    expect(planQueen([dep, t], t)).toEqual([dep.id]);
  });

  it("does not requeue a ticket that has a pull request", () => {
    const { epic, a, b } = board();
    a.prNumber = 4;
    expect(planQueen([epic, a, b], epic)).toEqual([]);
  });
});
