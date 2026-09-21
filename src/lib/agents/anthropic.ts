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
  AgentContext,
  AgentOutcome,
  ArchitectAgent,
  DraftTicket,
  ProductAgent,
  ShowcaseAgent,
  Usage,
} from "./ports";
import { type Prd, fileScopeSchema, prdSchema } from "@/lib/domain/entities";
import { validateDag } from "@/lib/domain/dag";
import { describeProblems } from "@/lib/domain/problems";
import { normalizeScope } from "@/lib/domain/scope";
import { estimateCostCents } from "@/lib/budget/limits";
import { requireCredential } from "@/lib/secrets/env";

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

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({
    apiKey: requireCredential("ANTHROPIC_API_KEY", "The agent pipelines"),
  });
  return cached;
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

const PRODUCT_SYSTEM = `You expand a raw feature request into a product requirements document for a single Epic.

Write for an engineer who will decompose this into tickets next. Be concrete about scope and ruthless about what is out of it. Prefer a short document that draws a clear boundary over a long one that hedges.

Do not invent product surface the request does not imply. If the request is too vague to scope, say so in the problem field rather than inventing requirements.`;

export class AnthropicProductAgent implements ProductAgent {
  async draftPrd(
    ctx: AgentContext,
    input: { epicId: string; rawRequest: string },
  ): Promise<AgentOutcome<{ title: string; prd: Prd }>> {
    const model = MODELS.product;

    const outputSchema = z.object({
      title: z.string().describe("A short imperative Epic title, under 80 characters."),
      prd: prdSchema,
    });

    try {
      const stream = client().beta.messages.stream({
        model,
        max_tokens: 8_000,
        system: PRODUCT_SYSTEM,
        thinking: { type: "adaptive" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { format: zodOutputFormat(outputSchema) },
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

const ARCHITECT_SYSTEM = `You decompose an Epic PRD into child tickets that autonomous coding agents will implement in parallel.

The file scope is the contract that makes parallelism safe. Two tickets that can run at the same time must not be able to touch the same files, and the platform enforces this: an agent whose diff strays outside its declared scope has the run rejected.

Rules:
- Declare fileScope as directory prefixes relative to the repository root, such as "src/components/board" or "prisma". Not globs.
- Tickets that could run concurrently must have disjoint scopes. If two tickets genuinely need the same directory, make one depend on the other instead.
- Shared files (package.json, lockfiles, tsconfig.json, the Prisma schema) serialise everything that touches them. Concentrate them in as few tickets as possible.
- dependsOn refers to the key of another ticket in this same response.
- Between 2 and 12 tickets. Each one must be a coherent, independently reviewable change.`;

const draftTicketSchema = z.object({
  key: z.string().describe('Short stable key, e.g. "T-1".'),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()).min(1),
  fileScope: fileScopeSchema,
  size: z.enum(["S", "M", "L", "XL"]),
  dependsOn: z.array(z.string()),
});

const decompositionSchema = z.object({
  tickets: z.array(draftTicketSchema).min(2).max(12),
});

/** Attempts before the Architect Agent gives up and asks for a human. */
const MAX_DECOMPOSITION_ATTEMPTS = 3;

export class AnthropicArchitectAgent implements ArchitectAgent {
  async decompose(
    ctx: AgentContext,
    input: { epicId: string; title: string; prd: Prd; repoTree: string[] },
  ): Promise<AgentOutcome<DraftTicket[]>> {
    const model = MODELS.architect;
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
        message = await client().beta.messages.create({
          model,
          max_tokens: 16_000,
          system: ARCHITECT_SYSTEM,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "high",
            format: zodOutputFormat(decompositionSchema),
          },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
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

      let tickets: DraftTicket[];
      try {
        const parsed = decompositionSchema.parse(JSON.parse(text));
        tickets = parsed.tickets.map((t) => ({
          ...t,
          fileScope: normalizeScope(t.fileScope),
        }));
      } catch (e) {
        messages.push(
          { role: "assistant", content: text },
          {
            role: "user",
            content: `That response could not be read as the required shape: ${
              e instanceof Error ? e.message : String(e)
            }\n\nReturn the same decomposition in the required format.`,
          },
        );
        continue;
      }

      // The model is not trusted to get the graph right. It is validated here,
      // and a failure is fed back as a correction rather than persisted.
      const validation = validateDag(
        tickets.map((t) => ({
          key: t.key,
          dependsOn: t.dependsOn,
          fileScope: t.fileScope,
        })),
      );

      if (validation.ok) {
        return { ok: true, value: tickets, usage: total };
      }

      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: [
            "That decomposition is not safe to run. Problems:",
            "",
            describeProblems(validation.problems),
            "",
            "Return a corrected decomposition in the same format.",
          ].join("\n"),
        },
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

const SHOWCASE_SYSTEM = `You write the closing showcase for a completed Epic: what shipped, and how someone would try it.

Write for the person who asked for the feature, not for the engineers who built it. Lead with what is now possible. Keep the walkthrough to concrete steps they can follow.

Output Markdown. No preamble, no sign-off.`;

export class AnthropicShowcaseAgent implements ShowcaseAgent {
  async summarize(
    ctx: AgentContext,
    input: {
      epicId: string;
      title: string;
      prd: Prd | null;
      ticketSummaries: Array<{ key: string; title: string; summary: string }>;
    },
  ): Promise<AgentOutcome<string>> {
    const model = MODELS.showcase;

    try {
      // Per-PR summaries are written at merge time, so this aggregates short
      // text rather than raw diffs. A large Epic would otherwise blow the
      // context on diff noise.
      const message = await client().beta.messages.create({
        model,
        max_tokens: 8_000,
        system: SHOWCASE_SYSTEM,
        thinking: { type: "adaptive" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
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
