/**
 * The eight lifecycle stages from the design specification, rendered as the
 * step indicator inside every Epic drawer.
 */

export const LIFECYCLE_STAGES = [
  { n: 1, key: "prompt", label: "Prompt" },
  { n: 2, key: "prd_draft", label: "PRD Draft" },
  { n: 3, key: "dag_breakdown", label: "DAG Breakdown" },
  { n: 4, key: "sandbox_mint", label: "Sandbox Mint" },
  { n: 5, key: "code_run", label: "Code Run" },
  { n: 6, key: "pr_opened", label: "PR Opened" },
  { n: 7, key: "rebase_merge", label: "Rebase & Merge" },
  { n: 8, key: "async_showcase", label: "Async Showcase" },
] as const;

export type StageKey = (typeof LIFECYCLE_STAGES)[number]["key"];
export type StageNumber = (typeof LIFECYCLE_STAGES)[number]["n"];

export type StageState = "pending" | "active" | "complete" | "failed";

export function stageByKey(key: StageKey) {
  const stage = LIFECYCLE_STAGES.find((s) => s.key === key);
  if (!stage) throw new Error(`Unknown lifecycle stage: ${key}`);
  return stage;
}

/** What the lifecycle stepper needs to know about an Epic's tickets. */
interface StageCard {
  status: string;
  stage: number;
}

/**
 * Where an Epic is on the lifecycle, and whether an agent is working on it
 * right now. An Epic's own stage stops at the DAG; past that its tickets
 * carry it, so the furthest ticket that has not stalled sets the stage.
 */
export function epicProgress(
  epic: StageCard,
  children: readonly StageCard[],
): { current: number; working: boolean } {
  let current = epic.stage;
  if (children.length > 0) current = Math.max(current, 4);
  for (const c of children) {
    if (c.status === "blocked" || c.status === "failed") continue;
    current = Math.max(current, c.status === "merged" ? 7 : c.stage);
  }
  if (children.length > 0 && children.every((c) => c.status === "merged")) {
    current = Math.max(current, 8);
  }
  const working =
    epic.status === "running" ||
    children.some((c) => c.status === "running" || c.status === "review");
  return { current: Math.min(current, LIFECYCLE_STAGES.length), working };
}
