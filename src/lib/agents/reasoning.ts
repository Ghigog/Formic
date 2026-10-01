import type { ModelInfo, ReasoningEffort } from "@/lib/llm/openai-compat";
import type { ProviderInfo } from "@/lib/llm/providers";
import type { AgentRole } from "@/lib/domain/entities";

/**
 * What a DeepSeek request asks for, per role. DeepSeek thinks at effort high
 * on every turn unless told otherwise, and once tools are in play that chain
 * of thought is sent back and billed as input each turn. So every request
 * says what it wants. The Claude path uses "medium"; DeepSeek has no medium,
 * and low is the honest analogue.
 */
export type ReasoningRole = "coder" | "reviewer" | "chat";

const WANTED: Record<ReasoningRole, { effort: ReasoningEffort; ceiling: number }> = {
  coder: { effort: "low", ceiling: 64_000 },
  reviewer: { effort: "low", ceiling: 64_000 },
  chat: { effort: "low", ceiling: 8_000 },
};

const LEVELS: ReasoningEffort[] = ["low", "high", "max"];

/**
 * The level to send: the one asked for if the model advertises it, else the
 * nearest advertised one (the cheaper on a tie), else none. A model that
 * advertises nothing gets the asked level; "none" is never a level.
 */
export function chooseEffort(asked: ReasoningEffort, info?: ModelInfo): ReasoningEffort | undefined {
  const advertised = info?.effort?.supportedLevels;
  if (!advertised) return asked;
  const known = LEVELS.filter((l) => advertised.includes(l));
  if (known.includes(asked)) return asked;
  const at = LEVELS.indexOf(asked);
  return [...known].sort(
    (a, b) => Math.abs(LEVELS.indexOf(a) - at) - Math.abs(LEVELS.indexOf(b) - at),
  )[0];
}

export interface RoleReasoning {
  thinking: { type: "enabled" | "disabled" };
  reasoningEffort?: ReasoningEffort;
  maxTokens: number;
}

/** What a role will use on this model; the editor shows it and the request carries it. */
export function roleReasoning(role: ReasoningRole, info?: ModelInfo): RoleReasoning {
  const { effort, ceiling } = WANTED[role];
  const reasoningEffort = chooseEffort(effort, info);
  return {
    // With no level the model accepts, thinking is off rather than left to the default.
    thinking: { type: reasoningEffort ? "enabled" : "disabled" },
    ...(reasoningEffort ? { reasoningEffort } : {}),
    maxTokens: info?.maxOutputTokens ? Math.min(ceiling, info.maxOutputTokens) : ceiling,
  };
}

/** The fields to spread into a `chat` request: only DeepSeek is told its effort. */
export function reasoningFor(
  p: ProviderInfo,
  role: ReasoningRole,
  info?: ModelInfo,
): Partial<RoleReasoning & { modelInfo: ModelInfo }> {
  if (p.id !== "deepseek") return {};
  return { ...roleReasoning(role, info), ...(info ? { modelInfo: info } : {}) };
}

/** The role a column's agent reasons as; the roles without a loop of their own chat. */
export function reasoningRoleFor(role: AgentRole): ReasoningRole {
  return role === "coder" || role === "reviewer" ? role : "chat";
}

/** One line for the agent editor: what the role will use. */
export function reasoningNote(r: RoleReasoning): string {
  const thinking = r.reasoningEffort ? `thinking effort ${r.reasoningEffort}` : "thinking off";
  return `${thinking}, up to ${r.maxTokens.toLocaleString("en-US")} output tokens per reply.`;
}
