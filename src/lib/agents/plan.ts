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

/** The plan role a step belongs to; a step without one is the coder's. */
const roleOf = (s: PlanStep) => s.role ?? "coder";

/**
 * A ticket's plan after one role sends its own: the other role's steps stay,
 * this role's are replaced. The coder's steps always come first and the
 * reviewer's after them, whoever sent last: a coder re-planning after a
 * send-back does not drop its steps below the review that asked for them.
 */
export function mergePlan(
  existing: readonly PlanStep[],
  incoming: readonly PlanStep[],
  role: "coder" | "reviewer",
): PlanStep[] {
  const steps = [...existing.filter((s) => roleOf(s) !== role), ...incoming.map((s) => ({ ...s, role }))];
  return [...steps.filter((s) => roleOf(s) === "coder"), ...steps.filter((s) => roleOf(s) === "reviewer")];
}

/** The role an event's steps were stamped with. */
export const planRole = (steps: readonly PlanStep[]): "coder" | "reviewer" =>
  steps[0] ? roleOf(steps[0]) : "coder";

/** The step being worked on, or the next one due. -1 when all are done. */
export function currentStep(steps: readonly PlanStep[]): number {
  const active = steps.findIndex((s) => s.status === "in_progress");
  return active !== -1 ? active : steps.findIndex((s) => s.status !== "done");
}

/** Share of a plan's steps marked done, for the card's progress bar. */
export function planFraction(steps: readonly PlanStep[]): number | null {
  if (steps.length === 0) return null;
  return steps.filter((s) => s.status === "done").length / steps.length;
}
