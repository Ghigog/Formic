import { describe, expect, it } from "vitest";
import { cannedChecks, cannedRubric, cappedByFindings, scoredReport, SCORE_RULES, unmetChecks } from "./rubric";
import { SENTINELS } from "./roster";

const rubric = cannedRubric(SENTINELS[0]!);
const pt = { text: "Something", ref: null };
const empty = { likes: [], dislikes: [], wrong: [], missing: [] };

describe("scoredReport", () => {
  it("caps 5 stars at 4 when any finding is listed", () => {
    for (const section of ["dislikes", "wrong", "missing"] as const) {
      const out = scoredReport(rubric, { ...empty, [section]: [pt] }, cannedChecks(rubric, 5));
      expect(out.stars).toBe(4);
      expect(cappedByFindings(rubric, out.report)).toBe(true);
    }
  });

  it("gives 5 stars with no findings", () => {
    const out = scoredReport(rubric, { ...empty, likes: [pt] }, cannedChecks(rubric, 5));
    expect(out.stars).toBe(5);
    expect(cappedByFindings(rubric, out.report)).toBe(false);
  });

  it("keeps the rubric's stars below 5 whatever is listed", () => {
    const out = scoredReport(rubric, { ...empty, wrong: [pt] }, cannedChecks(rubric, 2));
    expect(out.stars).toBe(2);
    expect(cappedByFindings(rubric, out.report)).toBe(false);
  });
});

describe("SCORE_RULES", () => {
  it("says 5 stars means no findings", () => {
    expect(SCORE_RULES).toContain("5 stars means you have no findings");
  });
});

describe("unmetChecks", () => {
  it("returns each unmet check with how to verify it", () => {
    const checks = cannedChecks(rubric, 3);
    const unmet = unmetChecks(rubric, checks);
    expect(unmet.map((u) => u.stars)).toEqual([4, 4, 5, 5]);
    expect(unmet[0]).toMatchObject({ text: rubric.rungs[2]!.checks[0]!.text, how: rubric.rungs[2]!.checks[0]!.how });
  });
});
