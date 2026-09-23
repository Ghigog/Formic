import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { AgentContext, AgentOutcome, CodeChange, Usage } from "./ports";
import type { Workspace } from "@/lib/sandbox/workspace";
import { ScopeError } from "@/lib/domain/scope";
import { DEFAULT_RUN_BUDGET, estimateCostCents, taskBudgetTokens } from "@/lib/budget/limits";
import { anthropicClient } from "./anthropic";
import { requestShape } from "./models";
import { type ProviderId, type ProviderInfo, provider } from "@/lib/llm/providers";
import { type ChatMessage, type ToolSpec, chat } from "@/lib/llm/openai-compat";

/**
 * The agentic loop both PROT-06 and PROT-07 run on.
 *
 * The Coder Agent and the Reviewer Agent differ in their brief, not in their
 * mechanics: both read a checkout, edit files, run commands and report what
 * they changed. Sharing the loop means the file-scope enforcement, the
 * truncation rules, the budget checks and the streaming all have one
 * implementation to get right.
 *
 * The tools execute in the sandbox, not on this host, which is why this is a
 * Messages API loop rather than a local coding harness: the harness would run
 * its file tools in the wrong process.
 */

export const CODER_MODEL = "claude-opus-5";


/** A loop that has not converged in this many turns is not about to. */
const MAX_ITERATIONS = 40;

/** Tool output past this is padding; the middle is what gets dropped. */
const MAX_TOOL_OUTPUT = 16_000;


export function truncate(text: string, limit = MAX_TOOL_OUTPUT): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const dropped = text.length - limit;
  return `${text.slice(0, half)}\n\n... [${dropped} characters omitted] ...\n\n${text.slice(-half)}`;
}

const bashInput = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().min(1).max(600).optional(),
});
const readInput = z.object({ path: z.string().min(1) });
const writeInput = z.object({ path: z.string().min(1), contents: z.string() });
const replaceInput = z.object({
  path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
});
const finishInput = z.object({
  summary: z.string().min(1),
  detail: z.string().min(1),
  verified_with: z.string().nullable(),
});

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "bash",
    description:
      "Run a shell command at the repository root inside the sandbox. Use it to explore the tree, run tests, and check your work.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_seconds: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "read_file",
    description: "Read a file, relative to the repository root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "write_file",
    description:
      "Write a file in full, relative to the repository root. Creates parent directories. Writes outside the ticket's file scope are rejected.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, contents: { type: "string" } },
      required: ["path", "contents"],
      additionalProperties: false,
    },
  },
  {
    name: "str_replace",
    description:
      "Replace one exact, unique occurrence of old_text with new_text in a file. Prefer this over write_file for edits to existing files.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description:
      "Call this once the change is complete and verified. Ends the run.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        detail: { type: "string" },
        verified_with: { type: ["string", "null"] },
      },
      required: ["summary", "detail", "verified_with"],
      additionalProperties: false,
    },
    strict: true,
  },
];

interface LoopInput {
  ctx: AgentContext;
  workspace: Workspace;
  ticketId: string;
  role: "coder" | "reviewer";
  system: string;
  prompt: string;
  /** Which provider, model and key; unset runs the built-in Claude coder. */
  provider?: ProviderId;
  model?: string;
  apiKey?: string | null;
}

/** A tool call, whichever provider asked for it. */
interface LoopCall {
  id: string;
  name: string;
  input: unknown;
}

interface Turn {
  calls: LoopCall[];
  stop: "done" | "refusal" | "max_tokens";
  usage: Usage;
}

/** Thrown for a turn worth simply asking again, e.g. a garbled tool input. */
class RetryTurn extends Error {}

/**
 * One provider's side of the conversation. The loop drives it with plain
 * tool calls and results; the conversation keeps its own wire format,
 * which matters for Claude, whose thinking blocks must go back unchanged.
 */
interface Conversation {
  next(): Promise<Turn>;
  toolResults(results: Array<{ id: string; content: string; isError: boolean }>): void;
  say(text: string): void;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    model: a.model,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    costCents: a.costCents + b.costCents,
  };
}

function usageFrom(model: string, tokensIn: number, tokensOut: number): Usage {
  return { model, tokensIn, tokensOut, costCents: estimateCostCents(model, tokensIn, tokensOut) };
}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Anthropic API. This run will need to be retried.";
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key was rejected.";
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API.";
  }
  if (e instanceof Anthropic.APIError) {
    return `Anthropic API error ${e.status ?? ""}: ${e.message}`.trim();
  }
  if (e instanceof Error) return e.message;
  return "Unknown agent failure.";
}

function claudeConversation(input: LoopInput, model: string): Conversation {
  const shape = requestShape(model, {
    effort: "xhigh",
    taskBudgetTokens: taskBudgetTokens(DEFAULT_RUN_BUDGET),
  });
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: input.prompt },
  ];
  return {
    async next() {
      let message: Anthropic.Beta.BetaMessage;
      try {
        const stream = anthropicClient(input.apiKey).beta.messages.stream({
          model,
          max_tokens: 64_000,
          system: input.system,
          ...(shape.thinking ? { thinking: shape.thinking } : {}),
          ...(shape.fallbacks ? { fallbacks: shape.fallbacks } : {}),
          output_config: shape.outputConfig,
          betas: shape.betas,
          tools: TOOLS,
          messages,
        });
        message = await stream.finalMessage();
      } catch (e) {
        // Eager input streaming hands validation to us, so an unparseable
        // tool input is a turn to re-issue rather than a run to fail. API
        // errors are not: those are real.
        if (!(e instanceof Anthropic.APIError)) throw new RetryTurn(describeError(e));
        throw new Error(describeError(e));
      }
      messages.push({ role: "assistant", content: message.content });
      return {
        calls: message.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input })),
        stop:
          message.stop_reason === "refusal"
            ? "refusal"
            : message.stop_reason === "max_tokens"
              ? "max_tokens"
              : "done",
        usage: usageFrom(model, message.usage.input_tokens, message.usage.output_tokens),
      };
    },
    toolResults(results) {
      messages.push({
        role: "user",
        content: results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          is_error: r.isError,
          content: r.content,
        })),
      });
    },
    say(text) {
      messages.push({ role: "user", content: text });
    },
  };
}

/** The same tools, in OpenAI's function format. */
const OPENAI_TOOLS: ToolSpec[] = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description ?? "", parameters: t.input_schema },
}));

function openAiConversation(
  input: LoopInput,
  info: ProviderInfo,
  model: string,
  apiKey: string,
): Conversation {
  const messages: ChatMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.prompt },
  ];
  return {
    async next() {
      const result = await chat(info, apiKey, {
        model,
        messages,
        tools: OPENAI_TOOLS,
        signal: input.ctx.signal,
      }).catch((e: unknown) => {
        throw new Error(e instanceof Error ? e.message : String(e));
      });
      messages.push({
        role: "assistant",
        content: result.message.content ?? "",
        ...(result.message.tool_calls?.length ? { tool_calls: result.message.tool_calls } : {}),
      });
      return {
        calls: (result.message.tool_calls ?? []).map((c) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(c.function.arguments || "{}");
          } catch {
            // Garbled arguments fail the tool's own validation, which tells
            // the model exactly what to fix.
            parsed = { unparseable: c.function.arguments };
          }
          return { id: c.id, name: c.function.name, input: parsed };
        }),
        stop: result.finishReason === "length" ? "max_tokens" : "done",
        usage: usageFrom(model, result.tokensIn, result.tokensOut),
      };
    },
    toolResults(results) {
      for (const r of results) {
        messages.push({
          role: "tool",
          tool_call_id: r.id,
          content: r.isError ? `Error: ${r.content}` : r.content,
        });
      }
    },
    say(text) {
      messages.push({ role: "user", content: text });
    },
  };
}

/**
 * Runs the loop until the agent calls `finish`, the budget stops it, or it
 * runs out of turns. Returns what the agent changed; committing and pushing
 * are the pipeline's job, because they are policy and this is mechanism.
 */
export async function runCodingLoop(
  input: LoopInput,
): Promise<AgentOutcome<CodeChange>> {
  const { ctx, workspace, role, ticketId } = input;
  const info = provider(input.provider ?? "anthropic")!;
  const model = input.model ?? CODER_MODEL;
  let total: Usage = { model, tokensIn: 0, tokensOut: 0, costCents: 0 };
  let retries = 0;

  const fail = (error: string, blocked = false): AgentOutcome<CodeChange> => ({
    ok: false,
    error,
    blocked,
    usage: total,
  });

  let conversation: Conversation;
  if (info.kind === "anthropic") {
    conversation = claudeConversation(input, model);
  } else {
    if (!input.apiKey) return fail(`This agent has no ${info.label} API key. Edit it and add one.`, true);
    conversation = openAiConversation(input, info, model, input.apiKey);
  }

  const progress = (label: string, iteration: number) => {
    ctx.emit({
      type: "run.progress",
      runId: ctx.runId,
      ticketId,
      role,
      label,
      fraction: Math.min(iteration / MAX_ITERATIONS, 0.95),
    });
  };

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (ctx.signal.aborted) {
      return fail("Run stopped before the change was finished.", true);
    }

    let turn: Turn;
    try {
      turn = await conversation.next();
      retries = 0;
    } catch (e) {
      if (e instanceof RetryTurn && retries++ < 2) continue;
      return fail(e instanceof Error ? e.message : String(e));
    }

    total = addUsage(total, turn.usage);
    await ctx.charge?.(turn.usage);

    if (turn.stop === "refusal") {
      return fail("The model declined to work on this ticket.", true);
    }
    if (turn.stop === "max_tokens") {
      return fail("The agent's turn was cut off before it finished.");
    }

    if (turn.calls.length === 0) {
      // Ended its turn without finishing. One nudge, then give up: a model
      // that cannot say what it did probably did not do it.
      if (iteration >= MAX_ITERATIONS - 1) break;
      conversation.say(
        "Call finish with a summary once the change is complete, or keep working if it is not.",
      );
      continue;
    }

    const results: Array<{ id: string; content: string; isError: boolean }> = [];

    for (const call of turn.calls) {
      if (call.name === "finish") {
        const parsed = finishInput.safeParse(call.input);
        if (parsed.success) {
          progress("Change complete", MAX_ITERATIONS);
          return {
            ok: true,
            value: {
              summary: parsed.data.summary,
              detail: parsed.data.detail,
              verifiedWith: parsed.data.verified_with,
            },
            usage: total,
          };
        }
        results.push({
          id: call.id,
          isError: true,
          content: `finish was malformed: ${parsed.error.issues[0]?.message}`,
        });
        continue;
      }

      const outcome = await runTool(call, workspace, ctx, ticketId);
      progress(outcome.label, iteration);
      results.push({ id: call.id, isError: outcome.isError, content: truncate(outcome.content) });
    }

    conversation.toolResults(results);
  }

  return fail(
    `The agent did not converge in ${MAX_ITERATIONS} turns. This needs a human.`,
    true,
  );
}

interface ToolOutcome {
  content: string;
  isError: boolean;
  label: string;
}

async function runTool(
  call: LoopCall,
  workspace: Workspace,
  ctx: AgentContext,
  ticketId: string,
): Promise<ToolOutcome> {
  try {
    switch (call.name) {
      case "bash": {
        const parsed = bashInput.safeParse(call.input);
        if (!parsed.success) {
          return invalid(parsed.error.issues[0]?.message, "bash");
        }
        const result = await workspace.exec(parsed.data.command, {
          timeoutMs: (parsed.data.timeout_seconds ?? 300) * 1000,
          signal: ctx.signal,
          onStdout: (line) =>
            ctx.emit({ type: "run.log", runId: ctx.runId, stream: "stdout", line }),
          onStderr: (line) =>
            ctx.emit({ type: "run.log", runId: ctx.runId, stream: "stderr", line }),
        });
        const body = [
          `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
          result.stdout && `stdout:\n${result.stdout}`,
          result.stderr && `stderr:\n${result.stderr}`,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: body,
          // A non-zero exit is information, not a tool failure. Marking it an
          // error would tell the model its command was malformed when in fact
          // the tests it just ran are red, which is the thing it needs to see.
          isError: false,
          label: `$ ${parsed.data.command.slice(0, 60)}`,
        };
      }

      case "read_file": {
        const parsed = readInput.safeParse(call.input);
        if (!parsed.success) {
          return invalid(parsed.error.issues[0]?.message, "read_file");
        }
        const contents = await workspace.readFile(parsed.data.path);
        return {
          content: contents,
          isError: false,
          label: `Reading ${parsed.data.path}`,
        };
      }

      case "write_file": {
        const parsed = writeInput.safeParse(call.input);
        if (!parsed.success) {
          return invalid(parsed.error.issues[0]?.message, "write_file");
        }
        await workspace.writeFile(parsed.data.path, parsed.data.contents);
        await emitDiff(workspace, ctx, parsed.data.path);
        return {
          content: `Wrote ${parsed.data.path}.`,
          isError: false,
          label: `Writing ${parsed.data.path}`,
        };
      }

      case "str_replace": {
        const parsed = replaceInput.safeParse(call.input);
        if (!parsed.success) {
          return invalid(parsed.error.issues[0]?.message, "str_replace");
        }
        const { path, old_text, new_text } = parsed.data;
        const before = await workspace.readFile(path);
        const first = before.indexOf(old_text);
        if (first === -1) {
          return {
            content: `old_text was not found in ${path}. Read the file and match it exactly.`,
            isError: true,
            label: `Editing ${path}`,
          };
        }
        if (before.indexOf(old_text, first + 1) !== -1) {
          return {
            content: `old_text appears more than once in ${path}. Include enough surrounding context to make it unique.`,
            isError: true,
            label: `Editing ${path}`,
          };
        }
        await workspace.writeFile(
          path,
          before.slice(0, first) + new_text + before.slice(first + old_text.length),
        );
        await emitDiff(workspace, ctx, path);
        return { content: `Edited ${path}.`, isError: false, label: `Editing ${path}` };
      }

      default:
        return { content: `Unknown tool ${call.name}.`, isError: true, label: call.name };
    }
  } catch (e) {
    if (e instanceof ScopeError) {
      // The one error worth phrasing carefully: it is the mechanism behind
      // the concurrency claim, and the agent can recover from it.
      return { content: e.message, isError: true, label: "Scope violation" };
    }
    return {
      content: e instanceof Error ? e.message : String(e),
      isError: true,
      label: call.name,
    };
  }
}

function invalid(detail: string | undefined, tool: string): ToolOutcome {
  return {
    content: `${tool} input was invalid: ${detail ?? "unknown field"}`,
    isError: true,
    label: tool,
  };
}

async function emitDiff(
  workspace: Workspace,
  ctx: AgentContext,
  path: string,
): Promise<void> {
  const patch = await workspace.diff(path).catch(() => "");
  if (!patch) return;
  ctx.emit({
    type: "run.diff",
    runId: ctx.runId,
    path,
    patch: truncate(patch, 8_000),
  });
}
