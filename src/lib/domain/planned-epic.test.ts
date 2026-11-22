import { describe, expect, it } from "vitest";

import { prdSchema } from "./entities";
import { prdFromTickets } from "./planned-epic";

describe("prdFromTickets", () => {
  it("reads a valid plan off the tickets: scope, stories and criteria", () => {
    const prd = prdFromTickets("Make CI faster", [
      { key: "E-T1", title: "Measure", description: "**User story:** As a dev, I'd like numbers.\n\n### Requirements", acceptanceCriteria: ["a"] },
      { key: "E-T2", title: "Run once", description: "", acceptanceCriteria: ["b"] },
    ]);
    expect(prd).toEqual({
      summary: "Make CI faster",
      problem: "Make CI faster",
      scope: ["E-T1: Measure", "E-T2: Run once"],
      outOfScope: [],
      technicalContext: [],
      userStories: ["As a dev, I'd like numbers.", "Run once"],
      successCriteria: ["a", "b"],
    });
    expect(prdSchema.safeParse(prd).success).toBe(true);
  });

  it("stays a valid plan when no ticket has acceptance criteria", () => {
    const prd = prdFromTickets("S", [{ key: "E-T1", title: "Measure", description: "d", acceptanceCriteria: [] }]);
    expect(prd.successCriteria).toEqual(["E-T1 is done: Measure"]);
    expect(prdSchema.safeParse(prd).success).toBe(true);
  });
});
