import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { AgentContext, AgentOutcome, CodeChange, Usage } from "./ports";
import type { Workspace } from "@/lib/sandbox/workspace";
import { ScopeError } from "@/lib/domain/scope";
import { DEFAULT_RUN_BUDGET, estimateCostCents, taskBudgetTokens } from "@/lib/budget/limits";
import { anthropicClient, describeError } from "./anthropic";
import { requestShape } from "./models";
import { MAX_PLAN_STEPS, checkPlan } from "./plan";
import { checkHandoff } from "./handoff";
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
/** Longest thought the board is sent in one piece. */
const MAX_THOUGHT = 4_000;

/**
 * Asked of every coding agent, so the person watching a ticket can follow
 * it: the plan up front, kept current, and a word before each action.
 */
const PLANNING_RULES = `Working in the open:
- Before you change anything, call update_plan with every step you intend to take. Keep it current: mark a step in_progress when you start it and done when it is finished, and add or drop steps as you learn more.
- Before each action, say in a sentence or two what you are about to do and why. The person watching the board reads it.`;


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
  // Optional here: a model that leaves it out has changed something.
  already_done: z.boolean().optional(),
  send_back: z.string().nullable().optional(),
  for_you: z.array(z.string()).optional(),
  blocked_reason: z.string().nullable().optional(),
});

const WORK_TOOLS: Anthropic.Beta.BetaTool[] = [
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
    name: "update_plan",
    description:
      "Share your plan for this ticket and keep it current. Call it before you change anything, with every step you intend to take, and again whenever a step starts or finishes. The person watching the board sees it.",
    input_schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const FOR_YOU = {
  type: "array",
  items: { type: "string" },
  description:
    "Steps outside the repository the person has to take themselves, one instruction each. Empty when there are none.",
};

const BLOCKED = {
  type: ["string", "null"],
  description:
    "Only when the project's checks cannot pass without changing files outside the file scope: what is failing and which files it needs. Null otherwise.",
};

/** How each role ends its run. */
const FINISH: Record<LoopInput["role"], Anthropic.Beta.BetaTool> = {
  coder: {
    name: "finish",
    description:
      "Call this once the change is complete and verified, or once you have confirmed the ticket was already done. Ends the run.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        detail: { type: "string" },
        verified_with: { type: ["string", "null"] },
        already_done: {
          type: "boolean",
          description:
            "True only when the repository already met every acceptance criterion and you changed nothing.",
        },
        for_you: FOR_YOU,
        blocked_reason: BLOCKED,
      },
      required: ["summary", "detail", "verified_with", "already_done", "for_you", "blocked_reason"],
      additionalProperties: false,
    },
    strict: true,
  },
  reviewer: {
    name: "finish",
    description:
      "Call this once you have approved the pull request, fixed it and verified the fix, or decided to send it back. Ends the run.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        detail: {
          type: "string",
          description: "Your review, criterion by criterion, and what you fixed if you fixed anything.",
        },
        verified_with: { type: ["string", "null"] },
        send_back: {
          type: ["string", "null"],
          description:
            "To send the ticket back to the Coder Agent: what is wrong and what to do about it. Change nothing when you send it back. Null to approve or fix.",
        },
        for_you: FOR_YOU,
        blocked_reason: BLOCKED,
      },
      required: ["summary", "detail", "verified_with", "send_back", "for_you", "blocked_reason"],
      additionalProperties: false,
    },
    strict: true,
  },
};

function toolsFor(role: LoopInput["role"]): Anthropic.Beta.BetaTool[] {
  return [...WORK_TOOLS, FINISH[role]];
}

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
  /** What the model thought and said this turn, besides its tool calls. */
  thoughts: Array<{ kind: "thinking" | "text"; text: string }>;
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
  /**
   * Adds a person's words to the turn about to be sent. For Claude they join
   * the tool results' message: two user messages in a row are refused.
   */
  note(text: string): void;
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
          tools: toolsFor(input.role),
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
        thoughts: message.content.flatMap((b): Turn["thoughts"] =>
          b.type === "thinking" && b.thinking.trim()
            ? [{ kind: "thinking" as const, text: b.thinking }]
            : b.type === "text" && b.text.trim()
              ? [{ kind: "text" as const, text: b.text }]
              : [],
        ),
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
    note(text) {
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push({ type: "text", text });
      } else {
        messages.push({ role: "user", content: text });
      }
    },
  };
}

/** The same tools, in OpenAI's function format. */
function openAiTools(role: LoopInput["role"]): ToolSpec[] {
  return toolsFor(role).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.input_schema },
  }));
}

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
        tools: openAiTools(input.role),
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
        thoughts: result.message.content?.trim()
          ? [{ kind: "text" as const, text: result.message.content }]
          : [],
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
    note(text) {
      messages.push({ role: "user", content: text });
    },
  };
}

/** What the agent reported. A reviewer's `sendBack` is null for a coder. */
export type LoopResult = CodeChange & { sendBack: string | null };

/**
 * Runs the loop until the agent calls `finish`, the budget stops it, or it
 * runs out of turns. Returns what the agent changed; committing and pushing
 * are the pipeline's job, because they are policy and this is mechanism.
 */
export async function runCodingLoop(
  input: LoopInput,
): Promise<AgentOutcome<LoopResult>> {
  const { ctx, workspace, role, ticketId } = input;
  const info = provider(input.provider ?? "anthropic")!;
  const model = input.model ?? CODER_MODEL;
  let total: Usage = { model, tokensIn: 0, tokensOut: 0, costCents: 0 };
  let retries = 0;

  const fail = (error: string, blocked = false): AgentOutcome<LoopResult> => ({
    ok: false,
    error,
    blocked,
    usage: total,
  });

  const briefed = { ...input, system: `${input.system.trim()}\n\n${PLANNING_RULES}` };
  let conversation: Conversation;
  if (info.kind === "anthropic") {
    conversation = claudeConversation(briefed, model);
  } else {
    if (!input.apiKey) return fail(`This agent has no ${info.label} API key. Edit it and add one.`, true);
    conversation = openAiConversation(briefed, info, model, input.apiKey);
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

    for (const thought of turn.thoughts) {
      ctx.emit({
        type: "run.thought",
        runId: ctx.runId,
        ticketId,
        kind: thought.kind,
        text: truncate(thought.text.trim(), MAX_THOUGHT),
      });
    }

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
          const blocked = parsed.data.blocked_reason?.trim();
          if (blocked) return fail(blocked, true);
          progress(role === "reviewer" ? "Review complete" : "Change complete", MAX_ITERATIONS);
          return {
            ok: true,
            value: {
              summary: parsed.data.summary,
              detail: parsed.data.detail,
              verifiedWith: parsed.data.verified_with,
              alreadyDone: parsed.data.already_done ?? false,
              handoff: checkHandoff(parsed.data.for_you),
              sendBack: parsed.data.send_back?.trim() || null,
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

      if (call.name === "update_plan") {
        const steps = checkPlan(call.input);
        if (steps) ctx.emit({ type: "ticket.plan", ticketId, steps });
        results.push({
          id: call.id,
          isError: !steps,
          content: steps
            ? "Plan updated."
            : `update_plan needs 1 to ${MAX_PLAN_STEPS} steps, each with a step and a status.`,
        });
        continue;
      }

      const outcome = await runTool(call, workspace, ctx);
      progress(outcome.label, iteration);
      results.push({ id: call.id, isError: outcome.isError, content: truncate(outcome.content) });
    }

    conversation.toolResults(results);

    // The person watching can stop the run or steer it between turns.
    const heard = await ctx.interrupts?.().catch(() => null);
    if (heard?.stopped) return fail(heard.stopped, true);
    for (const note of heard?.notes ?? []) {
      conversation.note(
        `A note from the person watching this ticket. Take it into account from here on:\n\n${note}`,
      );
    }
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
