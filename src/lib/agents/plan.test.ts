import { describe, expect, it } from "vitest";
import { checkPlan, currentStep, mergePlan, planFromSummary } from "./plan";

describe("checkPlan", () => {
  it("takes a well-formed plan", () => {
    expect(checkPlan({ steps: [{ step: "Read", status: "done" }] })).toEqual([
      { step: "Read", status: "done" },
    ]);
  });

  it("refuses an empty plan or a step with no status", () => {
    expect(checkPlan({ steps: [] })).toBeNull();
    expect(checkPlan({ steps: [{ step: "Read" }] })).toBeNull();
    expect(checkPlan("steps")).toBeNull();
  });
});

describe("planFromSummary", () => {
  it("reads a CLI agent's checklist", () => {
    const summary = [
      "T-1: Add the export",
      "",
      "Adds a CSV endpoint.",
      "",
      "Plan:",
      "- [x] Read the board model",
      "- [x] Add the endpoint",
      "- [ ] Add a download button",
    ].join("\n");
    expect(planFromSummary(summary)).toEqual([
      { step: "Read the board model", status: "done" },
      { step: "Add the endpoint", status: "done" },
      { step: "Add a download button", status: "pending" },
    ]);
  });

  it("is empty without a Plan section", () => {
    expect(planFromSummary("T-1: Add it\n\n- [x] not a plan")).toEqual([]);
  });
});

describe("currentStep", () => {
  it("is the step in progress, else the next one due", () => {
    expect(currentStep([{ step: "a", status: "done" }, { step: "b", status: "in_progress" }])).toBe(1);
    expect(currentStep([{ step: "a", status: "done" }, { step: "b", status: "pending" }])).toBe(1);
    expect(currentStep([{ step: "a", status: "done" }])).toBe(-1);
  });
});

describe("mergePlan", () => {
  const coder = [
    { step: "Write", status: "done" as const },
    { step: "Test", status: "pending" as const },
  ];
  const review = [{ step: "Read the diff", status: "pending" as const }];

  it("takes a first plan, stamped with its role", () => {
    expect(mergePlan([], coder, "coder")).toEqual([
      { step: "Write", status: "done", role: "coder" },
      { step: "Test", status: "pending", role: "coder" },
    ]);
  });

  it("replaces the same role's steps", () => {
    const first = mergePlan([], coder, "coder");
    expect(mergePlan(first, review, "coder").map((s) => s.step)).toEqual(["Read the diff"]);
  });

  it("appends a reviewer's plan after the coder's", () => {
    const merged = mergePlan(mergePlan([], coder, "coder"), review, "reviewer");
    expect(merged.map((s) => [s.step, s.role])).toEqual([
      ["Write", "coder"],
      ["Test", "coder"],
      ["Read the diff", "reviewer"],
    ]);
  });

  it("replaces only the reviewer's steps when it re-plans", () => {
    const both = mergePlan(mergePlan([], coder, "coder"), review, "reviewer");
    const again = mergePlan(both, [{ step: "Run it", status: "done" }], "reviewer");
    expect(again.map((s) => s.step)).toEqual(["Write", "Test", "Run it"]);
  });

  it("counts steps stored without a role as the coder's", () => {
    const merged = mergePlan(coder, review, "reviewer");
    expect(merged.map((s) => s.step)).toEqual(["Write", "Test", "Read the diff"]);
    expect(mergePlan(coder, review, "coder")).toHaveLength(1);
  });

  it("keeps the coder's steps first when the coder re-plans after a review", () => {
    const reviewed = mergePlan(mergePlan([], coder, "coder"), review, "reviewer");
    const reworked = mergePlan(reviewed, [{ step: "Fix the finding", status: "in_progress" }], "coder");
    expect(reworked.map((s) => [s.step, s.role])).toEqual([
      ["Fix the finding", "coder"],
      ["Read the diff", "reviewer"],
    ]);
  });
});
