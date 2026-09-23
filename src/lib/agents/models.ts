/**
 * The models a preset can run on, and what each one accepts.
 *
 * The request features the pipelines use are not uniform across models:
 * Haiku 4.5 takes no adaptive thinking or effort, and server-side refusal
 * fallbacks and task budgets are only sent where they are known to be
 * accepted. A preset that picks a model gets a request that model takes,
 * instead of a 400 on its first run.
 *
 * No server imports, so the preset editor lists the same models.
 */

export interface AgentModel {
  id: string;
  label: string;
  /** One line for the picker. */
  note: string;
  adaptiveThinking: boolean;
  effort: boolean;
  taskBudget: boolean;
  refusalFallbacks: boolean;
}

export const AGENT_MODELS: readonly AgentModel[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    note: "Strongest for decomposition and code",
    adaptiveThinking: true,
    effort: true,
    taskBudget: true,
    refusalFallbacks: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    note: "Fast and capable, lower cost",
    adaptiveThinking: true,
    effort: true,
    taskBudget: true,
    refusalFallbacks: false,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    note: "Cheapest, for simple briefs",
    adaptiveThinking: false,
    effort: false,
    taskBudget: false,
    refusalFallbacks: false,
  },
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    note: "Most capable, highest cost",
    adaptiveThinking: true,
    effort: true,
    taskBudget: false,
    refusalFallbacks: true,
  },
];

export function agentModel(id: string): AgentModel | undefined {
  return AGENT_MODELS.find((m) => m.id === id);
}

export function modelLabel(id: string): string {
  return agentModel(id)?.label ?? id;
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const TASK_BUDGET_BETA = "task-budgets-2026-03-13";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The model-dependent part of a Messages request. Spread it into the call;
 * the caller merges `output_config` with its own `format`.
 */
export function requestShape(
  model: string,
  options: { effort?: Effort; taskBudgetTokens?: number } = {},
): {
  thinking?: { type: "adaptive" };
  betas: string[];
  fallbacks?: "default";
  outputConfig: {
    effort?: Effort;
    task_budget?: { type: "tokens"; total: number };
  };
} {
  // Unknown ids are treated like the default model: the pipelines' own
  // choices are all in the table, so this only matters for stale presets.
  const m = agentModel(model) ?? AGENT_MODELS[0]!;
  const betas: string[] = [];
  const outputConfig: {
    effort?: Effort;
    task_budget?: { type: "tokens"; total: number };
  } = {};

  if (m.effort && options.effort) outputConfig.effort = options.effort;
  if (m.taskBudget && options.taskBudgetTokens) {
    outputConfig.task_budget = { type: "tokens", total: options.taskBudgetTokens };
    betas.push(TASK_BUDGET_BETA);
  }
  if (m.refusalFallbacks) betas.push(FALLBACK_BETA);

  return {
    ...(m.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
    ...(m.refusalFallbacks ? { fallbacks: "default" as const } : {}),
    betas,
    outputConfig,
  };
}
