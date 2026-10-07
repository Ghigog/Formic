import "server-only";

import type Anthropic from "@anthropic-ai/sdk";

import { anthropicClient, billedInputTokens, cachedSystem, cachedToHere } from "./anthropic";
import type { Usage } from "./ports";
import { estimateCostCents } from "@/lib/budget/limits";
import { type ChatMessage, type ModelInfo, type ToolSpec, advertisedModel, chat } from "@/lib/llm/openai-compat";
import { reasoningFor } from "@/lib/agents/reasoning";
import type { ProviderId, ProviderInfo } from "@/lib/llm/providers";

/**
 * One provider-agnostic turn of a tool-calling conversation: give it the
 * model's tool results, get back what it said and what it wants to call
 * next. Shared by the board's assistant and a card's chat, which differ
 * only in their system prompt and their tools.
 */

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface SpeakOptions {
  /**
   * Answer from what the conversation already holds, offering no tools. A
   * loop that has spent every round reading can still answer: the rounds are
   * gone, the reading is not. Without this the last thing a model does is ask
   * for one more file, and the turn ends with nothing to show for the reading
   * (see `outOfRoundsReply` in card-chat.ts).
   */
  answerOnly?: boolean;
}

export type Speak = (
  toolResults: Array<{ id: string; content: string; isError: boolean }> | null,
  options?: SpeakOptions,
) => Promise<{ text: string; calls: ToolCall[]; usage: Usage }>;

/**
 * What one turn cost, counted the way a run's turns are (see `usageFrom` in
 * coding-loop.ts): the cost is charged on cache-aware input tokens, since a
 * cached read is a tenth of plain input and `input_tokens` alone would make
 * every cached turn look nearly free, while the count a person reads is the
 * raw input. A provider that charges nothing per token — a flat-rate plan, an
 * id nobody has priced — costs zero here (see `estimateCostCents`), and its
 * turns are bounded by their clock instead.
 */
function turnUsage(
  model: string,
  tokensIn: number,
  tokensOut: number,
  costTokensIn: number,
  providerId?: ProviderId | null,
): Usage {
  return {
    model,
    tokensIn,
    tokensOut,
    costTokensIn,
    costCents: estimateCostCents(model, costTokensIn, tokensOut, providerId),
  };
}

export function claudeSpeak(
  apiKey: string | null,
  model: string,
  system: string,
  past: Array<{ role: "user" | "assistant"; content: string }>,
  tools: ToolDef[],
): Speak {
  const messages: Anthropic.MessageParam[] = past.map((m) => ({ role: m.role, content: m.content }));
  const claudeTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema as Anthropic.Tool.InputSchema,
  }));
  return async (results, options) => {
    if (results) {
      messages.push({
        role: "user",
        content: results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          is_error: r.isError,
          content: r.content,
        })),
      });
    }
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 8_000,
      system: cachedSystem(system),
      messages: cachedToHere(messages),
    };
    // No tools at all, rather than an empty list: the model cannot reach for
    // another file, so the turn ends in words.
    if (!options?.answerOnly) params.tools = claudeTools;
    const message = await anthropicClient(apiKey).messages.create(params);
    messages.push({ role: "assistant", content: message.content });
    const { tokensIn, costTokensIn } = billedInputTokens(message.usage);
    return {
      text: message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim(),
      calls: message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      usage: turnUsage(model, tokensIn, message.usage.output_tokens ?? 0, costTokensIn),
    };
  };
}

export function openAiSpeak(
  info: ProviderInfo,
  apiKey: string,
  model: string,
  system: string,
  past: Array<{ role: "user" | "assistant"; content: string }>,
  tools: ToolDef[],
): Speak {
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...past];
  const toolSpecs: ToolSpec[] = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
  let advertised: Promise<ModelInfo | undefined> | undefined;
  return async (results, options) => {
    for (const r of results ?? []) {
      messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content });
    }
    advertised ??= advertisedModel(info, apiKey, model);
    const result = await chat(info, apiKey, {
      model,
      messages,
      ...reasoningFor(info, "chat", await advertised),
      ...(options?.answerOnly ? {} : { tools: toolSpecs }),
    });
    // Kept whole, reasoning included: DeepSeek rejects a turn without it.
    messages.push(result.message);
    return {
      text: (result.message.content ?? "").trim(),
      calls: (result.message.tool_calls ?? []).map((c) => {
        let input: unknown;
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          input = { unparseable: c.function.arguments };
        }
        return { id: c.id, name: c.function.name, input };
      }),
      // No caching on this format: what the provider counts is what it bills.
      usage: turnUsage(model, result.tokensIn, result.tokensOut, result.costTokensIn ?? result.tokensIn, info.id),
    };
  };
}
