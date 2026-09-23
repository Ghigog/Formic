import "server-only";

import type { ProviderInfo } from "./providers";

/**
 * OpenAI's chat completions format, spoken at whichever address a provider
 * gives. OpenAI, Gemini, DeepSeek, OpenRouter and Groq all accept it, so
 * one small client over fetch covers them; no SDK per provider.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
  tokensIn: number;
  tokensOut: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function endpoint(p: ProviderInfo, path: string): string {
  if (!p.baseUrl) throw new Error(`${p.label} does not speak the OpenAI format.`);
  return `${p.baseUrl}${path}`;
}

function describeStatus(p: ProviderInfo, status: number, body: string): string {
  if (status === 401 || status === 403) return `${p.label} rejected the API key.`;
  if (status === 429) return `Rate limited by ${p.label}. This run will need to be retried.`;
  const detail = body.slice(0, 300).replace(/\s+/g, " ").trim();
  return `${p.label} error ${status}${detail ? `: ${detail}` : ""}`;
}

export async function chat(
  p: ProviderInfo,
  apiKey: string,
  request: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSpec[];
    /** Ask for a JSON object back. Dropped and retried if refused. */
    json?: boolean;
    signal?: AbortSignal;
  },
): Promise<ChatResult> {
  const send = async (json: boolean) => {
    const res = await fetch(endpoint(p, "/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: request.signal,
    }).catch((e: unknown) => {
      throw new ProviderError(
        `Could not reach ${p.label}: ${e instanceof Error ? e.message : String(e)}`,
        null,
      );
    });
    return res;
  };

  let res = await send(!!request.json);
  // Not every model behind these endpoints supports JSON mode. The prompt
  // asks for JSON anyway, so without it the answer is still parseable.
  if (!res.ok && request.json && res.status === 400) res = await send(false);
  if (!res.ok) {
    throw new ProviderError(describeStatus(p, res.status, await res.text()), res.status);
  }

  const body = (await res.json()) as {
    choices?: Array<{ message?: ChatMessage; finish_reason?: string | null }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0];
  if (!choice?.message) throw new ProviderError(`${p.label} returned no answer.`, res.status);
  return {
    message: choice.message,
    finishReason: choice.finish_reason ?? null,
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
  };
}

/** The model ids a key can use, for the agent editor. */
export async function listOpenAiModels(p: ProviderInfo, apiKey: string): Promise<string[]> {
  const res = await fetch(endpoint(p, "/models"), {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res) throw new ProviderError(`Could not reach ${p.label}.`, null);
  if (!res.ok) throw new ProviderError(describeStatus(p, res.status, await res.text()), res.status);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id.replace(/^models\//, "")).sort();
}

/**
 * A JSON object out of a model's text. Tolerates a code fence or a sentence
 * around it, which models without JSON mode like to add.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("The answer was not JSON.");
  }
}
