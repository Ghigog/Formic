import { describe, expect, it } from "vitest";
import type { Rubric } from "@/lib/db/repository";
import {
  calibrationSchema,
  cannedChecks,
  cannedRubric,
  cappedByFindings,
  finishedRubric,
  rubricText,
  scoredChecks,
  scoredReport,
  SCORE_RULES,
  unmetChecks,
} from "./rubric";
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

describe("command checks", () => {
  const GREP = "grep -rnE '#[0-9a-fA-F]{6}' src --include=*.tsx";
  const withCommand: Rubric = {
    context: "A web app.",
    rungs: [
      {
        stars: 2,
        checks: [
          { id: "2a", text: "No raw hex in components.", how: "Grep the components.", command: GREP, pass: "empty" },
          { id: "2b", text: "Tests pass.", how: "Run the tests.", command: "npm test", pass: "exit0" },
          { id: "2c", text: "Has a README.", how: "Read it." },
        ],
      },
    ],
  };

  it("lets the command's result decide, whatever the auditor concluded", () => {
    const [hex, tests, readme] = scoredChecks(withCommand, [
      { id: "2a", met: false, evidence: "The grep returned no lines.", ran: { exitCode: 1, output: "" } },
      { id: "2b", met: true, evidence: "Ran the tests.", ran: { exitCode: 1, output: "1 failed" } },
      { id: "2c", met: true, evidence: "README.md is there." },
    ]);
    expect(hex).toMatchObject({ met: true, ran: { exitCode: 1, output: "" } });
    expect(hex!.evidence).toContain("The command's result decided this check");
    expect(tests).toMatchObject({ met: false });
    expect(readme).toMatchObject({ met: true, evidence: "README.md is there." });
  });

  it("leaves the evidence alone when the auditor agreed with the command", () => {
    const [hex] = scoredChecks(withCommand, [{ id: "2a", met: false, evidence: "Two hexes.", ran: { exitCode: 0, output: "a.tsx:1:#ffffff" } }]);
    expect(hex).toMatchObject({ met: false, evidence: "Two hexes." });
  });

  it("falls back to the auditor's reading when the command was not run", () => {
    const [hex] = scoredChecks(withCommand, [{ id: "2a", met: true, evidence: "Read every component.", ran: null }]);
    expect(hex).toMatchObject({ met: true, evidence: "Read every component." });
  });

  it("shows the command and its pass rule wherever the check is read", () => {
    expect(rubricText(withCommand)).toContain(`Command: \`${GREP}\`, which passes when it prints nothing.`);
    const unmet = unmetChecks(withCommand, []);
    expect(unmet[1]!.how).toBe("Run the tests. Command: `npm test`, which passes when it exits 0.");
    expect(unmet[2]!.how).toBe("Read it.");
  });

  it("asks the auditor to run the command and report what it showed", () => {
    expect(SCORE_RULES).toContain("put its exit code and full output in ran");
  });

  it("keeps a calibration's commands, and defaults a command's rule to exit 0", () => {
    const calibration = calibrationSchema.parse({
      context: "A web app.",
      rungs: [2, 3, 4, 5].map((stars) => ({
        checks: [
          { text: `Check ${stars}.`, how: "Grep.", command: stars === 2 ? `  ${GREP}  ` : null, pass: stars === 2 ? "empty" : null },
          { text: `Other ${stars}.`, how: "Run it.", command: stars === 3 ? "npm test" : "  " },
          { text: `Read ${stars}.`, how: "Read it." },
        ],
      })),
    });
    const done = finishedRubric(calibration);
    if (!done.ok) throw new Error(done.problem);
    const [two, three] = done.rubric.rungs;
    expect(two!.checks[0]).toEqual({ id: "2a", text: "Check 2.", how: "Grep.", command: GREP, pass: "empty" });
    expect(three!.checks[1]).toEqual({ id: "3b", text: "Other 3.", how: "Run it.", command: "npm test", pass: "exit0" });
    expect(two!.checks[1]).toEqual({ id: "2b", text: "Other 2.", how: "Run it." });
    expect(two!.checks[2]).toEqual({ id: "2c", text: "Read 2.", how: "Read it." });
  });
});
