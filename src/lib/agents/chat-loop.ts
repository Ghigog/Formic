import "server-only";

import type Anthropic from "@anthropic-ai/sdk";

import { anthropicClient, cachedSystem, cachedToHere } from "./anthropic";
import { type ChatMessage, type ToolSpec, chat } from "@/lib/llm/openai-compat";
import type { ProviderInfo } from "@/lib/llm/providers";

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

export type Speak = (
  toolResults: Array<{ id: string; content: string; isError: boolean }> | null,
) => Promise<{ text: string; calls: ToolCall[] }>;

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
  return async (results) => {
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
    const message = await anthropicClient(apiKey).messages.create({
      model,
      max_tokens: 8_000,
      system: cachedSystem(system),
      tools: claudeTools,
      messages: cachedToHere(messages),
    });
    messages.push({ role: "assistant", content: message.content });
    return {
      text: message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim(),
      calls: message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
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
  return async (results) => {
    for (const r of results ?? []) {
      messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content });
    }
    const result = await chat(info, apiKey, { model, messages, tools: toolSpecs });
    messages.push({
      role: "assistant",
      content: result.message.content ?? "",
      ...(result.message.tool_calls?.length ? { tool_calls: result.message.tool_calls } : {}),
    });
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
    };
  };
}
