import { describe, expect, it } from "vitest";

import type { Rubric } from "@/lib/db/repository";

import { checkRubricFixFlags, onlyCheckChanged, reviseCheck, rubricFixesFromSummary } from "./rubric-fix";

const rubric: Rubric = {
  context: "An app",
  rungs: [
    { stars: 2, checks: [{ id: "3a", text: "A", how: "read a" }] },
    { stars: 3, checks: [{ id: "5b", text: "B", how: "read b", command: "ls", pass: "exit0" }] },
  ],
};
const next = { text: "B2", how: "read b2", command: null, pass: null };

describe("rubricFixesFromSummary", () => {
  it("reads a flag, resolving who to the roster id and keeping the path", () => {
    const text = "Done.\n\nRubric fixes:\n- Collum 5b: names a file that does not exist -> app/src/main/java/com/juice/overlay/OverlayService.kt\n\nPlan:\n- [x] a";
    expect(rubricFixesFromSummary(text)).toEqual([
      {
        sentinel: "architect",
        check: "5b",
        problem: "names a file that does not exist",
        suggestion: "app/src/main/java/com/juice/overlay/OverlayService.kt",
      },
    ]);
  });
  it("takes a roster id and drops unknown Sentinels", () => {
    const text = "Rubric fixes:\n- architect 2a: x -> y\n- Nobody 1a: x -> y";
    expect(rubricFixesFromSummary(text).map((f) => f.sentinel)).toEqual(["architect"]);
  });
  it("is empty without the section", () => {
    expect(rubricFixesFromSummary("nothing")).toEqual([]);
  });
});

describe("checkRubricFixFlags", () => {
  it("trims, drops incomplete flags and caps at five", () => {
    const ok = { sentinel: " architect ", check: "1a", problem: " p ", suggestion: "s" };
    expect(checkRubricFixFlags("x")).toEqual([]);
    expect(checkRubricFixFlags([ok, { ...ok, problem: " " }])).toEqual([{ ...ok, sentinel: "architect", problem: "p" }]);
    expect(checkRubricFixFlags(Array(8).fill(ok))).toHaveLength(5);
  });
});

describe("reviseCheck", () => {
  it("replaces only that check, keeping its id", () => {
    const out = reviseCheck(rubric, "5b", next);
    expect(out.rungs[1]!.checks[0]).toMatchObject({ id: "5b", text: "B2", how: "read b2" });
    expect(out.rungs[0]).toEqual(rubric.rungs[0]);
    expect(onlyCheckChanged(rubric, out, "5b")).toBe(true);
  });
  it("throws for an unknown id", () => {
    expect(() => reviseCheck(rubric, "9z", next)).toThrow();
  });
});

describe("onlyCheckChanged", () => {
  it("is false when another check changed too", () => {
    const after = reviseCheck(reviseCheck(rubric, "5b", next), "3a", { ...next, text: "other" });
    expect(onlyCheckChanged(rubric, after, "5b")).toBe(false);
  });
  it("is false when the context or an id changed", () => {
    expect(onlyCheckChanged(rubric, { ...reviseCheck(rubric, "5b", next), context: "lower" }, "5b")).toBe(false);
    const renamed = structuredClone(reviseCheck(rubric, "5b", next));
    renamed.rungs[1]!.checks[0]!.id = "5c";
    expect(onlyCheckChanged(rubric, renamed, "5b")).toBe(false);
  });
  it("is false when a rung's stars changed", () => {
    const after = structuredClone(rubric);
    after.rungs[0]!.stars = 4;
    expect(onlyCheckChanged(rubric, after, "5b")).toBe(false);
  });
});
