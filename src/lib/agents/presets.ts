import "server-only";

import { repository } from "@/lib/db";
import type { AgentPresetInput } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";
import { hintFor, open, seal } from "@/lib/secrets/vault";
import { AnthropicArchitectAgent, AnthropicProductAgent, AnthropicShowcaseAgent } from "./anthropic";
import { AnthropicCoderAgent, AnthropicReviewerAgent } from "./coder";
import type { AgentConfig, AgentRegistry } from "./ports";
import { agents, useMockAgents } from "./registry";
import { MODELS } from "./anthropic";
import { CODER_MODEL } from "./coding-loop";

/**
 * Presets on the way in (sealing the key) and on the way out (the agent a
 * column runs). The pipelines ask here for their agent instead of the
 * registry, so a column with a preset runs it and every other column runs
 * exactly what it did before.
 */

export async function savePreset(input: AgentPresetInput & { id?: string }) {
  return repository().savePreset({
    id: input.id,
    name: input.name,
    model: input.model,
    prompt: input.prompt,
    ...(input.apiKey === undefined
      ? {}
      : input.apiKey === null
        ? { apiKeyCipher: null, apiKeyHint: null }
        : { apiKeyCipher: seal(input.apiKey), apiKeyHint: hintFor(input.apiKey) }),
  });
}

/** The preset a column runs on this board, ready to hand to an agent. */
export async function agentConfigFor(
  projectId: string,
  column: ColumnId,
): Promise<AgentConfig | null> {
  const repo = repository();
  const presetId = (await repo.columnAgents(projectId))[column];
  if (!presetId) return null;
  const found = await repo.presetForRun(presetId);
  if (!found) return null;
  return {
    model: found.preset.model,
    brief: found.preset.prompt,
    // A key sealed under a secret that has since changed cannot be opened;
    // the run falls back to the server's key rather than failing outright.
    apiKey: found.apiKeyCipher ? open(found.apiKeyCipher) : null,
  };
}

const BUILD: {
  [K in keyof AgentRegistry]: {
    column: ColumnId;
    make: (config: AgentConfig) => AgentRegistry[K];
  };
} = {
  product: { column: "backlog", make: (c) => new AnthropicProductAgent(c) },
  architect: { column: "todo", make: (c) => new AnthropicArchitectAgent(c) },
  coder: { column: "in_progress", make: (c) => new AnthropicCoderAgent(c) },
  reviewer: { column: "in_review", make: (c) => new AnthropicReviewerAgent(c) },
  showcase: { column: "done", make: (c) => new AnthropicShowcaseAgent(c) },
};

/** The agent for a role on this board: its column's preset, or the default. */
export async function agentFor<K extends keyof AgentRegistry>(
  projectId: string,
  role: K,
): Promise<AgentRegistry[K]> {
  const { column, make } = BUILD[role];
  const config = await agentConfigFor(projectId, column);
  return config ? make(config) : agents()[role];
}

const BUILT_IN_MODEL: Record<keyof AgentRegistry, string> = {
  product: MODELS.product,
  architect: MODELS.architect,
  coder: CODER_MODEL,
  reviewer: CODER_MODEL,
  showcase: MODELS.showcase,
};

/**
 * The model a run for this role will use, for the card to show while it
 * works. Null for the mock agents, which use no model at all.
 */
export async function modelFor(
  projectId: string,
  role: keyof AgentRegistry,
): Promise<string | null> {
  const config = await agentConfigFor(projectId, BUILD[role].column);
  if (config?.model) return config.model;
  return useMockAgents() ? null : BUILT_IN_MODEL[role];
}
