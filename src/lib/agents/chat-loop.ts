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

export interface ChatLoopResult {
  /** How it ended: the model answered, the clock ran out, or every round went on tools. */
  end: "answered" | "out_of_time" | "out_of_rounds";
  /** What the model said last; for "out_of_rounds", its closing turn without tools. Empty when out of time. */
  text: string;
  /** The files it read, in order, without repeats. */
  read: string[];
  usage: Usage;
}

/**
 * Runs a tool-calling conversation to its end: asks the model, runs the tools
 * it calls, and goes again, until it answers, the clock runs out (checked
 * before each call, since a killed function writes nothing) or the rounds do,
 * and then it gets one last turn with no tools. Shared by a card's chat and a
 * call; each brings its own tools.
 */
export async function runChatLoop(options: {
  speak: Speak;
  runTool: (call: ToolCall) => Promise<{ content: string; isError: boolean }>;
  maxTurns: number;
  budgetMs: number;
}): Promise<ChatLoopResult> {
  const { speak, runTool, maxTurns, budgetMs } = options;
  const read = new Set<string>();
  const usage: Usage = { model: "", tokensIn: 0, tokensOut: 0, costCents: 0 };
  const spend = (u: Usage) => {
    usage.model = u.model || usage.model;
    usage.tokensIn += u.tokensIn;
    usage.tokensOut += u.tokensOut;
    usage.costCents += u.costCents;
  };
  let results: Array<{ id: string; content: string; isError: boolean }> | null = null;
  const startedAt = Date.now();
  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() - startedAt >= budgetMs) return { end: "out_of_time", text: "", read: [...read], usage };
    const { text, calls, usage: spent } = await speak(results);
    spend(spent);
    if (calls.length === 0) return { end: "answered", text, read: [...read], usage };
    results = [];
    for (const call of calls) {
      if (call.name === "read_file") {
        const path = (call.input as { path?: unknown } | null)?.path;
        if (typeof path === "string" && path.trim()) read.add(path.trim());
      }
      results.push({ id: call.id, ...(await runTool(call)) });
    }
  }
  const closing = await speak(null, { answerOnly: true });
  spend(closing.usage);
  return { end: "out_of_rounds", text: closing.text, read: [...read], usage };
}
