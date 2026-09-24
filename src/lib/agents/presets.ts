import "server-only";

import { repository } from "@/lib/db";
import type { AgentPreset, AgentPresetInput } from "@/lib/domain/entities";
import { formatReset } from "./limits";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";
import { hintFor, open, seal } from "@/lib/secrets/vault";
import {
  AnthropicArchitectAgent,
  AnthropicProductAgent,
  AnthropicShowcaseAgent,
  MODELS,
} from "./anthropic";
import { OpenAiArchitectAgent, OpenAiProductAgent, OpenAiShowcaseAgent } from "./openai-agents";
import { LoopCoderAgent, LoopReviewerAgent } from "./coder";
import type { AgentConfig, AgentOutcome, AgentRegistry } from "./ports";
import { agents, agentsOverridden } from "./registry";
import { CODER_MODEL } from "./coding-loop";
import { authMode } from "@/lib/auth/session";
import {
  provider as providerInfo,
  type ProviderId,
  type ProviderInfo,
} from "@/lib/llm/providers";

/**
 * Presets on the way in (sealing the key) and on the way out (the agent a
 * column runs). The pipelines ask here for their agent instead of the
 * registry, so a column with a preset runs it and every other column runs
 * exactly what it did before.
 */

export async function savePreset(
  input: AgentPresetInput & { id?: string; ownerId?: string | null },
) {
  return repository().savePreset({
    id: input.id,
    ownerId: input.ownerId,
    provider: input.provider,
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

/**
 * What runs a column on this board.
 *
 * A saved agent template carries its own provider, model, key and prompt;
 * nothing else supplies a key. A column without one does not quietly run on
 * someone's key: signed in with GitHub, its cards stop and say so. Local
 * mode keeps the old behaviour for development: Claude on the server's
 * ANTHROPIC_API_KEY if there is one, the mock agents if not.
 */
type Resolution =
  | { kind: "configured"; config: AgentConfig; presetId: string | null }
  | { kind: "mock" }
  | { kind: "unassigned" }
  | { kind: "limited"; reason: string };

/** The reason a preset takes no work right now, or null when it can. */
export function limitReason(preset: AgentPreset, where: string, now = Date.now()): string | null {
  if (!preset.limitedUntil) return null;
  const until = new Date(preset.limitedUntil);
  if (until.getTime() <= now) return null;
  return `${preset.name} is out of usage until ${formatReset(until)}. Wait for it, or pick an agent on another account for ${where}.`;
}

function envKey(id: ProviderId): string | null {
  const name = providerInfo(id)?.envKey;
  return (name && process.env[name]) || null;
}

async function resolveColumn(projectId: string, column: ColumnId): Promise<Resolution> {
  const repo = repository();
  const local = authMode() === "local";

  const presetId = (await repo.columnAgents(projectId))[column];
  const found = presetId ? await repo.presetForRun(presetId) : null;
  if (found) {
    const limited = limitReason(found.preset, COLUMN_LABELS[column]);
    if (limited) return { kind: "limited", reason: limited };
    const provider = found.preset.provider;
    return {
      kind: "configured",
      presetId: found.preset.id,
      config: {
        provider,
        model: found.preset.model,
        // An empty prompt keeps the column's built-in brief.
        brief: found.preset.prompt.trim() || undefined,
        // A key sealed under a secret that has since changed cannot be
        // opened; the agent then reports it has no key, which is the fix.
        apiKey:
          (found.apiKeyCipher ? open(found.apiKeyCipher) : null) ??
          (local ? envKey(provider) : null),
      },
    };
  }

  if (!local) return { kind: "unassigned" };
  if (process.env.AGENT_PROVIDER !== "mock" && envKey("anthropic")) {
    return {
      kind: "configured",
      config: { provider: "anthropic", apiKey: envKey("anthropic") },
      presetId: null,
    };
  }
  return { kind: "mock" };
}

/** Why a column takes no work right now: its agent is out of usage. */
export async function columnLimit(projectId: string, column: ColumnId): Promise<string | null> {
  if (agentsOverridden()) return null;
  const resolved = await resolveColumn(projectId, column);
  return resolved.kind === "limited" ? resolved.reason : null;
}

/** Kept for callers that only need the configuration, and for tests. */
export async function agentConfigFor(
  projectId: string,
  column: ColumnId,
): Promise<AgentConfig | null> {
  const resolved = await resolveColumn(projectId, column);
  return resolved.kind === "configured" ? resolved.config : null;
}

const BUILD: {
  [K in keyof AgentRegistry]: {
    column: ColumnId;
    make: (config: AgentConfig, claude: boolean) => AgentRegistry[K];
  };
} = {
  product: {
    column: "backlog",
    make: (c, claude) => (claude ? new AnthropicProductAgent(c) : new OpenAiProductAgent(c)),
  },
  architect: {
    column: "todo",
    make: (c, claude) => (claude ? new AnthropicArchitectAgent(c) : new OpenAiArchitectAgent(c)),
  },
  coder: { column: "in_progress", make: (c) => new LoopCoderAgent(c) },
  reviewer: { column: "in_review", make: (c) => new LoopReviewerAgent(c) },
  showcase: {
    column: "done",
    make: (c, claude) => (claude ? new AnthropicShowcaseAgent(c) : new OpenAiShowcaseAgent(c)),
  },
};

/** An agent that refuses every call with the same reason. */
function refusing(error: string): AgentRegistry[keyof AgentRegistry] {
  const refuse = async (): Promise<AgentOutcome<never>> => ({
    ok: false,
    blocked: true,
    error,
    usage: { model: "", tokensIn: 0, tokensOut: 0, costCents: 0 },
  });
  return {
    draftPrd: refuse,
    decompose: refuse,
    summarize: refuse,
    implement: refuse,
    review: refuse,
  } as unknown as AgentRegistry[keyof AgentRegistry];
}

/** An agent for a column nobody has given one. Every call says so. */
function unassigned(column: ColumnId): AgentRegistry[keyof AgentRegistry] {
  return refusing(
    `No agent is set for ${COLUMN_LABELS[column]}. Pick or create one from the column's agent menu.`,
  );
}

/** The agent for a role on this board. */
export async function agentFor<K extends keyof AgentRegistry>(
  projectId: string,
  role: K,
): Promise<AgentRegistry[K]> {
  if (agentsOverridden()) return agents()[role];
  const { column, make } = BUILD[role];
  const resolved = await resolveColumn(projectId, column);
  if (resolved.kind === "unassigned") return unassigned(column) as AgentRegistry[K];
  if (resolved.kind === "limited") return refusing(resolved.reason) as AgentRegistry[K];
  if (resolved.kind === "mock") return agents()[role];
  const info = providerInfo(resolved.config.provider ?? "anthropic");
  if (info?.kind === "cli") {
    // Every pipeline hands CLI agents to the runner before asking here.
    return refusing(
      `${info.label} runs in GitHub Actions and cannot answer here. Pick another agent for ${COLUMN_LABELS[column]}.`,
    ) as AgentRegistry[K];
  }
  return make(resolved.config, info?.kind !== "openai");
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
 * works. Null for the mock agents, and for a column with no agent.
 */
export async function modelFor(
  projectId: string,
  role: keyof AgentRegistry,
): Promise<string | null> {
  if (agentsOverridden()) return null;
  const resolved = await resolveColumn(projectId, BUILD[role].column);
  if (resolved.kind !== "configured") return null;
  const info = providerInfo(resolved.config.provider ?? "anthropic");
  if (info?.kind === "cli") return resolved.config.model || info.label;
  return resolved.config.model || BUILT_IN_MODEL[role];
}

/** A CLI agent's settings, as the runner needs them. */
export interface CliAgent {
  /** The saved agent, so a usage limit it hits can be recorded on it. */
  presetId: string | null;
  info: ProviderInfo & { kind: "cli"; cli: NonNullable<ProviderInfo["cli"]>; secretName: string };
  model: string | null;
  brief: string | null;
  /** The person's plan token or key. Null when the template has none. */
  credential: string | null;
}

/** The CLI agent a column runs, or null when it runs anything else. */
export async function cliAgentFor(
  projectId: string,
  column: ColumnId,
): Promise<CliAgent | null> {
  if (agentsOverridden()) return null;
  const resolved = await resolveColumn(projectId, column);
  if (resolved.kind !== "configured") return null;
  const info = providerInfo(resolved.config.provider ?? "anthropic");
  if (info?.kind !== "cli" || !info.cli || !info.secretName) return null;
  return {
    presetId: resolved.presetId,
    info: info as CliAgent["info"],
    model: resolved.config.model || null,
    brief: resolved.config.brief || null,
    credential: resolved.config.apiKey || null,
  };
}

/** The agent the board's assistant runs on, however it is reached. */
export type AssistantAgent =
  | { kind: "none" }
  | { kind: "limited"; reason: string }
  | { kind: "api"; info: ProviderInfo; model: string | null; apiKey: string | null; brief: string | null }
  | { kind: "cli"; agent: CliAgent };

export async function assistantAgentFor(projectId: string): Promise<AssistantAgent> {
  const repo = repository();
  const presetId = await repo.assistantAgent(projectId);
  const found = presetId ? await repo.presetForRun(presetId) : null;
  if (!found) return { kind: "none" };

  const info = providerInfo(found.preset.provider);
  if (!info) return { kind: "none" };
  const limited = limitReason(found.preset, "the assistant");
  if (limited) return { kind: "limited", reason: limited };
  const apiKey =
    (found.apiKeyCipher ? open(found.apiKeyCipher) : null) ??
    (authMode() === "local" ? envKey(info.id) : null);
  const model = found.preset.model || null;
  const brief = found.preset.prompt.trim() || null;

  if (info.kind === "cli") {
    if (!info.cli || !info.secretName) return { kind: "none" };
    return {
      kind: "cli",
      agent: { presetId: found.preset.id, info: info as CliAgent["info"], model, brief, credential: apiKey },
    };
  }
  return { kind: "api", info, model, apiKey, brief };
}

/** The agent that answers a card's chat, however it is reached. */
export type ColumnChatAgent =
  | { kind: "none"; reason: string }
  | { kind: "limited"; reason: string }
  | { kind: "api"; info: ProviderInfo; model: string | null; apiKey: string | null; brief: string | null }
  | { kind: "cli"; info: ProviderInfo; column: ColumnId };

/**
 * The agent to chat with about a card in this column: the same agent the
 * column runs its pipeline stage on. A CLI agent runs in GitHub Actions and
 * cannot hold a live conversation, so it reports that instead of chatting.
 */
export async function columnChatAgentFor(projectId: string, column: ColumnId): Promise<ColumnChatAgent> {
  const unavailable: ColumnChatAgent = {
    kind: "none",
    reason: `No agent is set for ${COLUMN_LABELS[column]}. Pick or create one from the column's agent menu.`,
  };
  const resolved = await resolveColumn(projectId, column);
  if (resolved.kind === "unassigned" || resolved.kind === "mock") return unavailable;
  if (resolved.kind === "limited") return { kind: "limited", reason: resolved.reason };
  const info = providerInfo(resolved.config.provider ?? "anthropic");
  if (!info) return unavailable;
  if (info.kind === "cli") return { kind: "cli", info, column };
  return {
    kind: "api",
    info,
    model: resolved.config.model || null,
    apiKey: resolved.config.apiKey || null,
    brief: resolved.config.brief || null,
  };
}
