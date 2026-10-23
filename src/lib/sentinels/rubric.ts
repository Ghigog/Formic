import { z } from "zod";

import type { AuditCheck, AuditKind, AuditReport, Rubric } from "@/lib/db/repository";
import type { Sentinel } from "./roster";

/**
 * A sentinel's rubric: the star ladder it writes for one project by
 * calibrating, and every later audit is scored against. Stars come from the
 * ladder, not from an impression, so two audits of the same code agree and a
 * fix that passes a check always shows.
 *
 * No server imports: the page shows the ladder and the server runs it.
 */

/** What a sentinel's run is for: writing its rubric, or scoring against one. */
export type Goal = { kind: "calibrate" } | { kind: "audit"; rubric: Rubric };

/** A run's goal from its record, or null for an audit started without a rubric. */
export function goalOf(run: { kind: AuditKind; rubric: Rubric | null }): Goal | null {
  if (run.kind === "calibrate") return { kind: "calibrate" };
  return run.rubric ? { kind: "audit", rubric: run.rubric } : null;
}

/** The rungs above the one-star floor. */
export const RUNG_STARS = [2, 3, 4, 5] as const;
/** Checks per rung, so a rung is a few clear bars and not a wish list. */
export const MAX_CHECKS = 4;

/** What every calibration is asked, after the sentinel's persona and brief. */
export const CALIBRATE_RULES = `You are calibrating, not auditing: do not rate the project. Learn what it is (its purpose, stack, size and stage) and write the star ladder you will audit it against for your role, from 2 to 5 stars; 1 star is the floor. A rung is earned only when all its checks pass and every rung below it is earned. 2 stars is the basics any project of this kind needs, 3 is safe to ship, 4 is solid, 5 is what you would sign off without changes. Give each rung 2 to ${MAX_CHECKS} checks. Each check is one pass/fail statement about this project that a later audit can verify the same way every time, from the code or by running a command: name the files, commands and thresholds, and avoid words like "good", "clean" or "enough". Fit the checks to this project and leave out what does not apply to it. Write the ladder as the bar to meet, whether or not the project meets it today. Only name files you were actually shown.`;

/** What every audit is asked about its rubric. */
export const SCORE_RULES = `Your stars are not yours to choose: they come from the rubric below, which you wrote when you calibrated on this project. For every check, say whether it is met and give the evidence: the file and line you read, or the command you ran and what it showed. A check you could not verify is not met; say why. Judge each check exactly as written: do not raise or lower its bar, and do not add checks. Everything else you find goes in the report, where it informs the next calibration. 5 stars means you have no findings: every finding you report (what does not work, what is wrong, what is missing) holds the project below 5, so an audit that meets every check but lists a finding is scored 4.`;

export const calibrationSchema = z.object({
  context: z.string().describe("Two plain sentences: what this project is, and what matters most in it for your role."),
  rungs: z
    .array(
      z.object({
        checks: z
          .array(
            z.object({
              text: z.string().describe("One pass/fail statement about this project."),
              how: z.string().describe("How to verify it: the file to read or the command to run, and what passing looks like."),
            }),
          )
          .describe(`2 to ${MAX_CHECKS} checks.`),
      }),
    )
    .describe("Exactly four rungs, for 2, 3, 4 and 5 stars, lowest first."),
});

export type Calibration = z.infer<typeof calibrationSchema>;

/** A calibration as the page stores it, or why it cannot be used. */
export function finishedRubric(c: Calibration): { ok: true; rubric: Rubric } | { ok: false; problem: string } {
  const rungs = c.rungs.slice(0, RUNG_STARS.length);
  if (rungs.length < RUNG_STARS.length || rungs.some((r) => r.checks.length === 0)) {
    return { ok: false, problem: "The rubric needs four rungs, for 2 to 5 stars, each with at least one check." };
  }
  return {
    ok: true,
    rubric: {
      context: c.context.trim(),
      rungs: rungs.map((r, i) => {
        const stars = RUNG_STARS[i]!;
        return {
          stars,
          checks: r.checks.slice(0, MAX_CHECKS).map((k, j) => ({
            id: `${stars}${String.fromCharCode(97 + j)}`,
            text: k.text.trim(),
            how: k.how.trim(),
          })),
        };
      }),
    },
  };
}

/** One star, plus each rung whose checks are all met, up to the first that is not. */
export function starsFrom(rubric: Rubric, checks: AuditCheck[]): number {
  const met = new Set(checks.filter((c) => c.met).map((c) => c.id));
  let stars = 1;
  for (const rung of rubric.rungs) {
    if (!rung.checks.every((k) => met.has(k.id))) break;
    stars = rung.stars;
  }
  return stars;
}

/** Every check of the rubric scored once, in its order: one left out is not met. */
export function scoredChecks(rubric: Rubric, answered: AuditCheck[]): AuditCheck[] {
  const byId = new Map(answered.map((c) => [c.id.trim(), c]));
  return rubric.rungs.flatMap((r) =>
    r.checks.map((k) => {
      const a = byId.get(k.id);
      return a
        ? { id: k.id, met: a.met, evidence: a.evidence.trim() }
        : { id: k.id, met: false, evidence: "Not scored in the audit." };
    }),
  );
}

/** The rubric as the audit reads it. */
export function rubricText(rubric: Rubric): string {
  return [
    `Rubric. ${rubric.context}`,
    ...rubric.rungs.map((r) =>
      [`${r.stars} stars:`, ...r.checks.map((k) => `- [${k.id}] ${k.text} (Verify: ${k.how})`)].join("\n"),
    ),
  ].join("\n\n");
}

/** The checks that stand between the stars an audit gave and five. */
export function unmetChecks(rubric: Rubric, checks: AuditCheck[]): Array<{ stars: number; text: string; evidence: string }> {
  const byId = new Map(checks.map((c) => [c.id, c]));
  return rubric.rungs.flatMap((r) =>
    r.checks
      .filter((k) => !byId.get(k.id)?.met)
      .map((k) => ({ stars: r.stars, text: k.text, evidence: byId.get(k.id)?.evidence ?? "" })),
  );
}

/** Whether two rubrics hold the same checks, so an audit still reads against the current one. */
export function sameRubric(a: Rubric | null, b: Rubric | null): boolean {
  return !!a && !!b && JSON.stringify(a.rungs) === JSON.stringify(b.rungs);
}

/** A rubric for the mock agents, built from the role's brief. */
export function cannedRubric(s: Sentinel): Rubric {
  const bar = ["The basics are in place", "Safe to ship", "Solid", "Signed off without changes"];
  return {
    context: `A demo rubric for ${s.name}, written without reading code.`,
    rungs: RUNG_STARS.map((stars, i) => ({
      stars,
      checks: [
        { id: `${stars}a`, text: `${bar[i]} for ${s.name.toLowerCase()}: part one.`, how: "A mock check: always reads the same." },
        { id: `${stars}b`, text: `${bar[i]} for ${s.name.toLowerCase()}: part two.`, how: "A mock check: always reads the same." },
      ],
    })),
  };
}

/** Mock checks that land on the given stars. */
export function cannedChecks(rubric: Rubric, stars: number): AuditCheck[] {
  return rubric.rungs.flatMap((r) =>
    r.checks.map((k) => ({ id: k.id, met: r.stars <= stars, evidence: r.stars <= stars ? "Seen in the demo." : "Not in the demo." })),
  );
}

/** Whether a report lists any finding: something that does not work, is wrong or is missing. */
const hasFindings = (report: Omit<AuditReport, "checks">) =>
  report.dislikes.length + report.wrong.length + report.missing.length > 0;

/** Whether findings hold an audit at 4 stars though its checks would give it 5. */
export function cappedByFindings(rubric: Rubric, report: AuditReport): boolean {
  return starsFrom(rubric, report.checks ?? []) === 5 && hasFindings(report);
}

/** A finished audit's report with its checks, and the stars they earn: 5 only with no findings. */
export function scoredReport(rubric: Rubric, report: Omit<AuditReport, "checks">, answered: AuditCheck[]) {
  const checks = scoredChecks(rubric, answered);
  const stars = starsFrom(rubric, checks);
  return { stars: stars === 5 && hasFindings(report) ? 4 : stars, report: { ...report, checks } satisfies AuditReport };
}
