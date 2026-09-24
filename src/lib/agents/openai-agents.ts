import "server-only";

import { z } from "zod";
import type {
  AgentAttachment,
  AgentConfig,
  AgentContext,
  AgentOutcome,
  ArchitectAgent,
  DraftTicket,
  ExistingTicket,
  ProductAgent,
  ShowcaseAgent,
  Usage,
} from "./ports";
import { decompositionGuidance } from "./decomposition-guidance";
import { type Prd, prdSchema } from "@/lib/domain/entities";
import { estimateCostCents } from "@/lib/budget/limits";
import {
  ARCHITECT_BRIEF,
  PRODUCT_BRIEF,
  SHOWCASE_BRIEF,
  withPlanningConventions,
  withProductConventions,
} from "./prompts";
import {
  MAX_DECOMPOSITION_ATTEMPTS,
  checkDecomposition,
  decompositionSchema,
  ticketSpecSchema,
  toDraftTicket,
} from "./decomposition";
import { type ChatMessage, chat, extractJson } from "@/lib/llm/openai-compat";
import { type ProviderInfo, provider } from "@/lib/llm/providers";

/**
 * The Product, Architect and Showcase agents on any provider that speaks
 * OpenAI's format: Gemini, DeepSeek, OpenRouter, Groq, OpenAI itself.
 *
 * Same briefs and the same checks as the Claude versions. What differs is
 * how structure is asked for: not every model here supports a schema, so
 * the schema goes in the prompt, JSON mode is requested where it exists,
 * and the answer is validated here either way.
 */

interface Resolved {
  info: ProviderInfo;
  model: string;
  apiKey: string;
}

function resolve(config: AgentConfig): Resolved | string {
  const info = provider(config.provider ?? "");
  if (!info || info.kind !== "openai") return "This agent's provider is not set up.";
  if (!config.model) return `This agent has no ${info.label} model. Edit it and pick one.`;
  if (!config.apiKey) return `This agent has no ${info.label} API key. Edit it and add one.`;
  return { info, model: config.model, apiKey: config.apiKey };
}

function usage(model: string, tokensIn: number, tokensOut: number): Usage {
  return { model, tokensIn, tokensOut, costCents: estimateCostCents(model, tokensIn, tokensOut) };
}

function add(a: Usage, b: Usage): Usage {
  return {
    model: a.model,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    costCents: a.costCents + b.costCents,
  };
}

function failure(model: string, error: string, blocked = false, used?: Usage): AgentOutcome<never> {
  return {
    ok: false,
    error,
    blocked,
    usage: used ?? { model, tokensIn: 0, tokensOut: 0, costCents: 0 },
  };
}

/** The brief, plus the exact shape the answer has to take. */
function jsonSystem(brief: string, schema: z.ZodType): string {
  return `${brief}

Respond with a single JSON object and nothing else, matching this JSON Schema:
${JSON.stringify(z.toJSONSchema(schema))}`;
}

/** Asks until the answer parses as `schema`, feeding each problem back. */
async function askForJson<T>(
  r: Resolved,
  ctx: AgentContext,
  messages: ChatMessage[],
  accept: (raw: unknown) => { ok: true; value: T } | { ok: false; correction: string },
  attempts: number,
  onAttempt?: (attempt: number) => void,
): Promise<{ ok: true; value: T; usage: Usage } | { ok: false; error: string; usage: Usage }> {
  let total = usage(r.model, 0, 0);
  let lastProblem = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (ctx.signal.aborted) return { ok: false, error: "Run stopped before it finished.", usage: total };
    onAttempt?.(attempt);
    let result;
    try {
      result = await chat(r.info, r.apiKey, {
        model: r.model,
        messages,
        json: true,
        signal: ctx.signal,
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), usage: total };
    }
    total = add(total, usage(r.model, result.tokensIn, result.tokensOut));
    const text = result.message.content ?? "";

    let raw: unknown = null;
    try {
      raw = extractJson(text);
    } catch {
      // Handled as a correction below.
    }
    const checked = raw === null
      ? { ok: false as const, correction: "That was not a JSON object. Respond with only the JSON object." }
      : accept(raw);
    if (checked.ok) return { ok: true, value: checked.value, usage: total };

    lastProblem = checked.correction;
    messages.push({ role: "assistant", content: text }, { role: "user", content: checked.correction });
  }
  return { ok: false, error: lastProblem, usage: total };
}

export const productOutput = z.object({
  title: z.string().describe("A short imperative Epic title, under 80 characters."),
  prd: prdSchema,
});

export class OpenAiProductAgent implements ProductAgent {
  constructor(private readonly config: AgentConfig) {}

  async draftPrd(
    ctx: AgentContext,
    input: { epicId: string; rawRequest: string; attachments: AgentAttachment[] },
  ): Promise<
    AgentOutcome<
      | { kind: "prd"; title: string; prd: Prd }
      | { kind: "reroute"; reason: string; ticket: DraftTicket }
    >
  > {
    const r = resolve(this.config);
    if (typeof r === "string") return failure(this.config.model ?? "", r, true);

    const result = await askForJson(
      r,
      ctx,
      [
        { role: "system", content: jsonSystem(withProductConventions(this.config.brief ?? PRODUCT_BRIEF), productOutput) },
        { role: "user", content: `Raw feature request:\n\n${input.rawRequest}` },
      ],
      (raw) => {
        const parsed = productOutput.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : {
              ok: false,
              correction: `That PRD does not match the schema: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}. Return the corrected JSON object.`,
            };
      },
      2,
    );
    ctx.emit({ type: "epic.prd", epicId: input.epicId, delta: "", done: true });

    if (!result.ok) {
      return failure(r.model, `The Product Agent returned a malformed PRD: ${result.error}`, false, result.usage);
    }
    return { ok: true, value: { kind: "prd", ...result.value }, usage: result.usage };
  }
}

export class OpenAiArchitectAgent implements ArchitectAgent {
  constructor(private readonly config: AgentConfig) {}

  async decompose(
    ctx: AgentContext,
    input: {
      epicId: string;
      title: string;
      prd: Prd;
      repoTree: string[];
      existing?: ExistingTicket[];
      instructions?: string[];
    },
  ): Promise<AgentOutcome<DraftTicket[]>> {
    const r = resolve(this.config);
    if (typeof r === "string") return failure(this.config.model ?? "", r, true);

    const result = await askForJson(
      r,
      ctx,
      [
        {
          role: "system",
          content: jsonSystem(withPlanningConventions(this.config.brief ?? ARCHITECT_BRIEF), decompositionSchema),
        },
        {
          role: "user",
          content: [
            `Epic: ${input.title}`,
            "",
            "PRD:",
            JSON.stringify(input.prd, null, 2),
            "",
            "Existing top-level directories in the repository:",
            input.repoTree.slice(0, 200).join("\n") || "(empty repository)",
            decompositionGuidance(input.existing, input.instructions),
          ].join("\n"),
        },
      ],
      (raw) => {
        const checked = checkDecomposition(raw);
        return checked.ok ? { ok: true, value: checked.tickets } : checked;
      },
      MAX_DECOMPOSITION_ATTEMPTS,
      (attempt) =>
        ctx.emit({
          type: "run.progress",
          runId: ctx.runId,
          ticketId: null,
          role: "architect",
          label: attempt === 1 ? "Decomposing epic" : `Correcting the graph (attempt ${attempt})`,
          fraction: attempt / MAX_DECOMPOSITION_ATTEMPTS,
        }),
    );

    if (!result.ok) {
      return failure(
        r.model,
        `The Architect Agent could not produce a valid dependency graph in ${MAX_DECOMPOSITION_ATTEMPTS} attempts. This Epic needs a human to split it.`,
        true,
        result.usage,
      );
    }
    return { ok: true, value: result.value, usage: result.usage };
  }

  async draftTicket(
    ctx: AgentContext,
    input: { rawRequest: string; repoTree: string[]; attachments: AgentAttachment[] },
  ): Promise<
    AgentOutcome<{ kind: "ticket"; ticket: DraftTicket } | { kind: "reroute"; reason: string }>
  > {
    const r = resolve(this.config);
    if (typeof r === "string") return failure(this.config.model ?? "", r, true);

    const result = await askForJson(
      r,
      ctx,
      [
        {
          role: "system",
          content: jsonSystem(withPlanningConventions(this.config.brief ?? ARCHITECT_BRIEF), ticketSpecSchema),
        },
        {
          role: "user",
          content: [
            "Raw feature request:",
            input.rawRequest,
            "",
            "Existing top-level directories in the repository:",
            input.repoTree.slice(0, 200).join("\n") || "(empty repository)",
          ].join("\n"),
        },
      ],
      (raw) => {
        const parsed = ticketSpecSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : {
              ok: false,
              correction: `That ticket does not match the schema: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}. Return the corrected JSON object.`,
            };
      },
      2,
    );

    if (!result.ok) {
      return failure(r.model, `The Architect Agent returned a malformed ticket: ${result.error}`, false, result.usage);
    }
    return { ok: true, value: { kind: "ticket", ticket: toDraftTicket(result.value) }, usage: result.usage };
  }
}

export class OpenAiShowcaseAgent implements ShowcaseAgent {
  constructor(private readonly config: AgentConfig) {}

  async summarize(
    ctx: AgentContext,
    input: {
      epicId: string;
      title: string;
      prd: Prd | null;
      ticketSummaries: Array<{ key: string; title: string; summary: string }>;
    },
  ): Promise<AgentOutcome<string>> {
    const r = resolve(this.config);
    if (typeof r === "string") return failure(this.config.model ?? "", r, true);

    try {
      const result = await chat(r.info, r.apiKey, {
        model: r.model,
        signal: ctx.signal,
        messages: [
          { role: "system", content: this.config.brief ?? SHOWCASE_BRIEF },
          {
            role: "user",
            content: [
              `Epic: ${input.title}`,
              input.prd ? `\nOriginal intent: ${input.prd.summary}` : "",
              "",
              "Merged tickets:",
              ...input.ticketSummaries.map((t) => `- ${t.key} ${t.title}: ${t.summary}`),
            ].join("\n"),
          },
        ],
      });
      const used = usage(r.model, result.tokensIn, result.tokensOut);
      const markdown = (result.message.content ?? "").trim();
      if (!markdown) return failure(r.model, "The showcase came back empty.", false, used);
      ctx.emit({ type: "epic.showcase", epicId: input.epicId, markdown });
      return { ok: true, value: markdown, usage: used };
    } catch (e) {
      return failure(r.model, e instanceof Error ? e.message : String(e));
    }
  }
}
