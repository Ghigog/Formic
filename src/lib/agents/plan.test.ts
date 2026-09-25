import { describe, expect, it } from "vitest";
import { checkPlan, currentStep, planFromSummary } from "./plan";

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
