import "server-only";

import type { ProviderInfo } from "./providers";
import { describeProviderError, isTransientProviderError } from "@/lib/agents/limits";

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

function describeStatus(p: ProviderInfo, res: Response, body: string): string {
  return describeProviderError({
    label: p.label,
    status: res.status,
    message: body,
    retryAfter: res.headers.get("retry-after"),
  });
}

/** A reply, in whichever envelope the provider chose to send it. */
interface Completion {
  choices?: Array<{ message?: ChatMessage; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * The completion inside a body, unwrapped. Not every endpoint sends the plain
 * OpenAI shape: ClinePass answers a non-streamed request with the completion
 * under `data`, beside a `success` flag, and no top-level `choices` — while its
 * own documentation shows the plain one. Reading only the top level reports an
 * answer that arrived as no answer at all.
 */
function completionIn(body: unknown): Completion | null {
  if (typeof body !== "object" || body === null) return null;
  for (const envelope of [body, (body as { data?: unknown }).data]) {
    if (typeof envelope !== "object" || envelope === null) continue;
    const choices = (envelope as Completion).choices;
    if (Array.isArray(choices) && choices.length > 0) return envelope as Completion;
  }
  return null;
}

/**
 * What the provider said instead, when a 200 carries an error rather than a
 * completion. Cline's gateway sends its reason as a plain string beside
 * `success`; OpenAI and DeepSeek nest it under `error.message`.
 */
function saidInstead(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  for (const envelope of [body, (body as { data?: unknown }).data]) {
    if (typeof envelope !== "object" || envelope === null) continue;
    const error = (envelope as { error?: unknown }).error;
    const message = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) {
      return message.replace(/\s+/g, " ").trim().slice(0, 300);
    }
  }
  return null;
}

/** The tries after the first: how long each waits before making it. */
const RETRY_WAITS_MS = [1_000, 4_000];

/**
 * Waits, unless the run is stopped first: a card pulled out of a run should
 * not be held open by a retry waiting on a provider nobody is asking any more.
 */
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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
  // A provider's own roof falling in is not a run's ending. Cline's gateway
  // answers a model that came back empty with a 500, and a loop that gave up
  // there ended a thirty-minute job on its third turn; the same request a
  // moment later is usually served. These waits are the tries after the
  // first, and the run's own stop is never something to wait out. The Claude
  // path already gets this from its SDK, which retries a 5xx twice by
  // default; this client, over plain fetch, had nothing.
  for (let attempt = 0; ; attempt++) {
    try {
      return await chatOnce(p, apiKey, request);
    } catch (e) {
      const wait = RETRY_WAITS_MS[attempt];
      if (wait === undefined || request.signal?.aborted) throw e;
      if (!(e instanceof ProviderError) || !isTransientProviderError({ status: e.status, message: e.message })) {
        throw e;
      }
      await pause(wait, request.signal);
    }
  }
}

/** One request, with the JSON-mode drop. `chat` is the call every caller makes. */
async function chatOnce(
  p: ProviderInfo,
  apiKey: string,
  request: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSpec[];
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
        // Some endpoints stream by default (Cline's does), and this client
        // reads one JSON body. Nothing here wants the stream.
        stream: false,
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
    throw new ProviderError(describeStatus(p, res, await res.text()), res.status);
  }

  // A body that will not parse is not an answer either. Left as the
  // SyntaxError it is, it would slip past the retry in `chat` — which only
  // asks again about the provider's own failures — and reach the card as a
  // JavaScript message naming no provider and nothing a person can act on.
  // An abort here is the run being stopped, which is not the provider's side.
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    if (request.signal?.aborted) throw e;
    throw new ProviderError(
      `${p.label} answered with something that is not JSON. That is ${p.label}'s side, not the ticket's: move the card back in a minute to retry.`,
      res.status,
    );
  }
  const completion = completionIn(body);
  const choice = completion?.choices?.[0];
  if (!choice?.message) {
    const said = saidInstead(body);
    throw new ProviderError(
      said ? `${p.label} answered with an error: ${said}` : `${p.label} returned no answer.`,
      res.status,
    );
  }
  return {
    message: choice.message,
    finishReason: choice.finish_reason ?? null,
    tokensIn: completion?.usage?.prompt_tokens ?? 0,
    tokensOut: completion?.usage?.completion_tokens ?? 0,
  };
}

/** The model ids a key can use, for the agent editor. */
export async function listOpenAiModels(p: ProviderInfo, apiKey: string): Promise<string[]> {
  const res = await fetch(endpoint(p, "/models"), {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res) throw new ProviderError(`Could not reach ${p.label}.`, null);
  if (!res.ok) throw new ProviderError(describeStatus(p, res, await res.text()), res.status);
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
