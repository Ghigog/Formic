import { planStepSchema, type PlanStep } from "@/lib/domain/entities";

/**
 * An agent's plan for a ticket: the steps it means to take, each pending,
 * in progress or done. API agents keep it current with a tool as they work;
 * a CLI agent in GitHub Actions writes it into its summary, read afterwards.
 */

export const MAX_PLAN_STEPS = 20;

/** A plan as an agent sent it, cleaned up, or null when it is not one. */
export function checkPlan(raw: unknown): PlanStep[] | null {
  const steps = (raw as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const parsed = steps.slice(0, MAX_PLAN_STEPS).map((s) => planStepSchema.safeParse(s));
  if (parsed.some((p) => !p.success)) return null;
  return parsed.map((p) => p.data!);
}

/**
 * The "Plan:" checklist in a CLI agent's summary: "- [x] step" is done,
 * "- [ ] step" was left. Empty when there is none.
 */
export function planFromSummary(text: string): PlanStep[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*#*\s*plan\s*:?\s*$/i.test(l));
  if (start === -1) return [];
  const steps: PlanStep[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
    if (!m) {
      if (line.trim() === "" && steps.length === 0) continue;
      if (line.trim() === "") break;
      continue;
    }
    steps.push({ step: m[2]!.slice(0, 300), status: m[1] === " " ? "pending" : "done" });
    if (steps.length >= MAX_PLAN_STEPS) break;
  }
  return steps;
}

/** The step being worked on, or the next one due. -1 when all are done. */
export function currentStep(steps: readonly PlanStep[]): number {
  const active = steps.findIndex((s) => s.status === "in_progress");
  return active !== -1 ? active : steps.findIndex((s) => s.status !== "done");
}
