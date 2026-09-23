import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from "@anthropic-ai/sdk/error";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type {
  AgentConfig,
  AgentContext,
  AgentOutcome,
  ArchitectAgent,
  DraftTicket,
  ProductAgent,
  ShowcaseAgent,
  Usage,
} from "./ports";
import { type Prd, prdSchema } from "@/lib/domain/entities";
import { estimateCostCents } from "@/lib/budget/limits";
import { env } from "@/lib/secrets/env";
import { authMode } from "@/lib/auth/session";
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
} from "./decomposition";
import { requestShape } from "./models";

/**
 * Real agents.
 *
 * Model choice: Opus 5 with adaptive thinking. The PRD in the repository root
 * names Claude 3.5 Sonnet, which is several generations stale; the model id
 * lives in MODELS below so changing it is one edit rather than a grep.
 *
 * Every call opts into server-side refusal fallbacks. A safety classifier
 * declining a request returns HTTP 200 with stop_reason "refusal", and without
 * a fallback that surfaces as an agent silently producing nothing.
 */

export const MODELS = {
  /** PRD drafting. The least demanding of the pipelines. */
  product: "claude-sonnet-5",
  /** Decomposition and file-scope isolation. The hard one. */
  architect: "claude-opus-5",
  /** Aggregating merged diffs into a readable document. */
  showcase: "claude-sonnet-5",
} as const;

/** One client per API key: a preset may bring its own. */
const clients = new Map<string, Anthropic>();

/** A preset's own key, or the server's. */
export function anthropicClient(apiKey?: string | null): Anthropic {
  // The server's key is for local development only. Signed in with GitHub,
  // an agent runs on the key its template carries or not at all.
  const key = apiKey || (authMode() === "local" ? env().ANTHROPIC_API_KEY : undefined);
  if (!key) {
    throw new Error("This agent has no Anthropic API key. Edit it and add one.");
  }
  let c = clients.get(key);
  if (!c) {
    c = new Anthropic({ apiKey: key });
    clients.set(key, c);
  }
  return c;
}

function usageFrom(
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
): Usage {
  const tokensIn = usage?.input_tokens ?? 0;
  const tokensOut = usage?.output_tokens ?? 0;
  return {
    model,
    tokensIn,
    tokensOut,
    costCents: estimateCostCents(model, tokensIn, tokensOut),
  };
}

function failure(
  model: string,
  error: string,
  blocked = false,
  usage?: Usage,
): AgentOutcome<never> {
  return {
    ok: false,
    error,
    blocked,
    usage: usage ?? { model, tokensIn: 0, tokensOut: 0, costCents: 0 },
  };
}

/**
 * Turns an SDK error into something a card can display. Most specific first:
 * a single broad catch would lose the retryable / not-retryable distinction
 * that decides whether a run is worth another attempt.
 */
function describeError(e: unknown): string {
  if (e instanceof RateLimitError) {
    return "Rate limited by the Anthropic API. This run will need to be retried.";
  }
  if (e instanceof AuthenticationError) {
    return "The Anthropic API key was rejected.";
  }
  if (e instanceof APIConnectionError) {
    return "Could not reach the Anthropic API.";
  }
  if (e instanceof APIError) {
    return `Anthropic API error ${e.status ?? ""}: ${e.message}`.trim();
  }
  if (e instanceof Error) return e.message;
  return "Unknown agent failure.";
}

export class AnthropicProductAgent implements ProductAgent {
  constructor(private readonly config: AgentConfig = {}) {}

  async draftPrd(
    ctx: AgentContext,
    input: { epicId: string; rawRequest: string },
  ): Promise<AgentOutcome<{ title: string; prd: Prd }>> {
    const model = this.config.model ?? MODELS.product;
    const shape = requestShape(model);

    const outputSchema = z.object({
      title: z.string().describe("A short imperative Epic title, under 80 characters."),
      prd: prdSchema,
    });

    try {
      const stream = anthropicClient(this.config.apiKey).beta.messages.stream({
        model,
        max_tokens: 8_000,
        system: withProductConventions(this.config.brief ?? PRODUCT_BRIEF),
        ...(shape.thinking ? { thinking: shape.thinking } : {}),
        ...(shape.fallbacks ? { fallbacks: shape.fallbacks } : {}),
        betas: shape.betas,
        output_config: { ...shape.outputConfig, format: zodOutputFormat(outputSchema) },
        messages: [
          {
            role: "user",
            content: `Raw feature request:\n\n${input.rawRequest}`,
          },
        ],
      });

      // Stream the document into the drawer as it is written. Most of the
      // perceived quality of this feature is that it fills in rather than
      // appearing after a long blank pause.
      stream.on("text", (delta) => {
        ctx.emit({
          type: "epic.prd",
          epicId: input.epicId,
          delta,
          done: false,
        });
      });

      const message = await stream.finalMessage();
      ctx.emit({ type: "epic.prd", epicId: input.epicId, delta: "", done: true });

      const usage = usageFrom(model, message.usage);

      if (message.stop_reason === "refusal") {
        return failure(
          model,
          "The model declined this request. Rephrase the backlog item.",
          true,
          usage,
        );
      }
      if (message.stop_reason === "max_tokens") {
        return failure(model, "The PRD was cut off before it finished.", false, usage);
      }

      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const parsed = outputSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        return failure(
          model,
          `The Product Agent returned a malformed PRD: ${parsed.error.issues[0]?.message}`,
          false,
          usage,
        );
      }

      return { ok: true, value: parsed.data, usage };
    } catch (e) {
      return failure(model, describeError(e));
    }
  }
}

export class AnthropicArchitectAgent implements ArchitectAgent {
  constructor(private readonly config: AgentConfig = {}) {}

  async decompose(
    ctx: AgentContext,
    input: { epicId: string; title: string; prd: Prd; repoTree: string[] },
  ): Promise<AgentOutcome<DraftTicket[]>> {
    const model = this.config.model ?? MODELS.architect;
    const shape = requestShape(model, { effort: "high" });
    const messages: Anthropic.Beta.BetaMessageParam[] = [
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
        ].join("\n"),
      },
    ];

    let total: Usage = { model, tokensIn: 0, tokensOut: 0, costCents: 0 };

    for (let attempt = 1; attempt <= MAX_DECOMPOSITION_ATTEMPTS; attempt++) {
      if (ctx.signal.aborted) {
        return failure(model, "Run stopped before decomposition finished.", true, total);
      }

      ctx.emit({
        type: "run.progress",
        runId: ctx.runId,
        ticketId: null,
        role: "architect",
        label: attempt === 1 ? "Decomposing epic" : `Correcting the graph (attempt ${attempt})`,
        fraction: attempt / MAX_DECOMPOSITION_ATTEMPTS,
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await anthropicClient(this.config.apiKey).beta.messages.create({
          model,
          max_tokens: 16_000,
          system: withPlanningConventions(this.config.brief ?? ARCHITECT_BRIEF),
          ...(shape.thinking ? { thinking: shape.thinking } : {}),
          ...(shape.fallbacks ? { fallbacks: shape.fallbacks } : {}),
          output_config: {
            ...shape.outputConfig,
            format: zodOutputFormat(decompositionSchema),
          },
          betas: shape.betas,
          messages,
        });
      } catch (e) {
        return failure(model, describeError(e), false, total);
      }

      const usage = usageFrom(model, message.usage);
      total = {
        model,
        tokensIn: total.tokensIn + usage.tokensIn,
        tokensOut: total.tokensOut + usage.tokensOut,
        costCents: total.costCents + usage.costCents,
      };

      if (message.stop_reason === "refusal") {
        return failure(model, "The model declined to decompose this Epic.", true, total);
      }

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
      const checked = checkDecomposition(raw);
      if (checked.ok) return { ok: true, value: checked.tickets, usage: total };

      messages.push(
        { role: "assistant", content: text },
        { role: "user", content: checked.correction },
      );
    }

    return failure(
      model,
      `The Architect Agent could not produce a valid dependency graph in ${MAX_DECOMPOSITION_ATTEMPTS} attempts. This Epic needs a human to split it.`,
      true,
      total,
    );
  }
}

export class AnthropicShowcaseAgent implements ShowcaseAgent {
  constructor(private readonly config: AgentConfig = {}) {}

  async summarize(
    ctx: AgentContext,
    input: {
      epicId: string;
      title: string;
      prd: Prd | null;
      ticketSummaries: Array<{ key: string; title: string; summary: string }>;
    },
  ): Promise<AgentOutcome<string>> {
    const model = this.config.model ?? MODELS.showcase;
    const shape = requestShape(model);

    try {
      // Per-PR summaries are written at merge time, so this aggregates short
      // text rather than raw diffs. A large Epic would otherwise blow the
      // context on diff noise.
      const message = await anthropicClient(this.config.apiKey).beta.messages.create({
        model,
        max_tokens: 8_000,
        system: this.config.brief ?? SHOWCASE_BRIEF,
        ...(shape.thinking ? { thinking: shape.thinking } : {}),
        ...(shape.fallbacks ? { fallbacks: shape.fallbacks } : {}),
        betas: shape.betas,
        messages: [
          {
            role: "user",
            content: [
              `Epic: ${input.title}`,
              input.prd ? `\nOriginal intent: ${input.prd.summary}` : "",
              "",
              "Merged tickets:",
              ...input.ticketSummaries.map(
                (t) => `- ${t.key} ${t.title}: ${t.summary}`,
              ),
            ].join("\n"),
          },
        ],
      });

      const usage = usageFrom(model, message.usage);

      if (message.stop_reason === "refusal") {
        return failure(model, "The model declined to write this showcase.", true, usage);
      }

      const markdown = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      if (!markdown) {
        return failure(model, "The showcase came back empty.", false, usage);
      }

      ctx.emit({ type: "epic.showcase", epicId: input.epicId, markdown });
      return { ok: true, value: markdown, usage };
    } catch (e) {
      return failure(model, describeError(e));
    }
  }
}
