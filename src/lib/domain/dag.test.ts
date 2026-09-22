import { describe, expect, it } from "vitest";
import {
  type DagNode,
  concurrentBatch,
  topologicalOrder,
  unblocked,
  validateDag,
} from "./dag";
import { describeProblems } from "./problems";

const node = (
  key: string,
  dependsOn: string[] = [],
  fileScope: string[] = [`src/${key}`],
): DagNode => ({ key, dependsOn, fileScope });

describe("validateDag", () => {
  it("accepts a well-formed graph with disjoint scopes", () => {
    const result = validateDag([
      node("a"),
      node("b", ["a"]),
      node("c", ["a"]),
      node("d", ["b", "c"]),
    ]);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("detects a cycle", () => {
    const result = validateDag([
      node("a", ["c"]),
      node("b", ["a"]),
      node("c", ["b"]),
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === "cycle")).toBe(true);
  });

  it("detects a self-dependency", () => {
    const result = validateDag([node("a", ["a"])]);
    expect(result.problems.some((p) => p.kind === "self")).toBe(true);
  });

  it("detects a dangling dependency", () => {
    const result = validateDag([node("a", ["ghost"])]);
    expect(result.problems).toContainEqual({
      kind: "dangling",
      from: "a",
      to: "ghost",
    });
  });

  it("detects duplicate keys", () => {
    const result = validateDag([node("a"), node("a")]);
    expect(result.problems).toContainEqual({ kind: "duplicate", key: "a" });
  });

  it("rejects overlapping scopes between concurrent tickets", () => {
    const result = validateDag([
      node("a", [], ["src/components"]),
      node("b", [], ["src/components/ui"]),
    ]);
    expect(result.ok).toBe(false);
    const overlap = result.problems.find((p) => p.kind === "scope_overlap");
    expect(overlap).toBeDefined();
    if (overlap?.kind === "scope_overlap") {
      expect(overlap.paths.length).toBeGreaterThan(0);
    }
  });

  it("allows overlapping scopes when one ticket depends on the other", () => {
    const result = validateDag([
      node("a", [], ["src/components"]),
      node("b", ["a"], ["src/components/ui"]),
    ]);
    expect(result.ok).toBe(true);
  });

  it("allows overlapping scopes across a transitive dependency", () => {
    const result = validateDag([
      node("a", [], ["src/components"]),
      node("b", ["a"], ["src/lib"]),
      node("c", ["b"], ["src/components/ui"]),
    ]);
    expect(result.ok).toBe(true);
  });

  it("produces a correction message naming both tickets", () => {
    const result = validateDag([
      node("a", [], ["src/components"]),
      node("b", [], ["src/components/ui"]),
    ]);
    const text = describeProblems(result.problems);
    expect(text).toContain('"a"');
    expect(text).toContain('"b"');
    expect(text).toContain("src/components");
  });
});

describe("topologicalOrder", () => {
  it("puts dependencies first", () => {
    const order = topologicalOrder([
      node("d", ["b", "c"]),
      node("b", ["a"]),
      node("c", ["a"]),
      node("a"),
    ]);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("throws on a cyclic graph", () => {
    expect(() => topologicalOrder([node("a", ["b"]), node("b", ["a"])])).toThrow();
  });
});

describe("unblocked", () => {
  it("returns roots when nothing is complete", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c")];
    expect(unblocked(nodes, new Set()).sort()).toEqual(["a", "c"]);
  });

  it("releases a ticket once every dependency is complete", () => {
    const nodes = [node("a"), node("b"), node("c", ["a", "b"])];
    expect(unblocked(nodes, new Set(["a"]))).toEqual(["b"]);
    expect(unblocked(nodes, new Set(["a", "b"]))).toEqual(["c"]);
  });
});

describe("concurrentBatch", () => {
  it("runs independent tickets with disjoint scopes together", () => {
    const nodes = [
      node("a", [], ["src/ui"]),
      node("b", [], ["src/api"]),
      node("c", ["a"], ["src/lib"]),
    ];
    expect(concurrentBatch(nodes, new Set()).sort()).toEqual(["a", "b"]);
  });

  it("never schedules two tickets that touch the shared surface", () => {
    const nodes = [
      node("a", [], ["package.json"]),
      node("b", [], ["prisma"]),
      node("c", [], ["src/ui"]),
    ];
    const batch = concurrentBatch(nodes, new Set());
    const shared = batch.filter((k) => k === "a" || k === "b");
    expect(shared).toHaveLength(1);
    expect(batch).toContain("c");
  });

  it("respects tickets already running", () => {
    const nodes = [
      node("a", [], ["src/ui"]),
      node("b", [], ["src/ui/button"]),
      node("c", [], ["src/api"]),
    ];
    const batch = concurrentBatch(nodes, new Set(), new Set(["a"]));
    expect(batch).toEqual(["c"]);
  });

  it("excludes tickets whose dependencies are unmet", () => {
    const nodes = [node("a", [], ["src/ui"]), node("b", ["a"], ["src/api"])];
    expect(concurrentBatch(nodes, new Set())).toEqual(["a"]);
  });
});
