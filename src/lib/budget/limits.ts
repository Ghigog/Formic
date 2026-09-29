/**
 * Spend ceilings.
 *
 * Two loops in this system retry with a model in the middle: the Coder Agent
 * iterating on failing tests, and the Reviewer Agent iterating on CI. Both run
 * unattended. Every one of them runs under a ceiling that stops the work and
 * parks the card rather than spending until someone notices.
 *
 * Pure module: no I/O, so the arithmetic is testable on its own.
 */

import { provider as providerInfo, type ProviderId } from "@/lib/llm/providers";

export interface Budget {
  /** Hard ceiling on spend for this scope, in cents. */
  maxCents: number;
  /** Wall-clock ceiling in milliseconds. */
  maxDurationMs: number;
  /** How many times a failing step may be retried. */
  maxAttempts: number;
}

/**
 * A run's own ceiling stays under the `maxDuration` declared on the routes
 * that start one (see src/app/api/{epics,tickets,transitions}), which mirror
 * the serverless platform's own cap (300s on Vercel's Hobby plan). A run that
 * checks this between turns and stops itself, with margin for the turn
 * already in flight, reports "ran out of time" and is retryable; a run the
 * platform kills outright never gets the chance to say anything.
 */
export const DEFAULT_RUN_BUDGET: Budget = {
  maxCents: 200,
  maxDurationMs: 4 * 60 * 1000,
  maxAttempts: 3,
};

export const DEFAULT_EPIC_BUDGET: Budget = {
  maxCents: 2_000,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxAttempts: 12,
};

/**
 * What a ticket's size gives it, before any setting says otherwise: ten
 * minutes a story point. This is the default `docs/run-time-budgets.md`
 * describes; the settings that let a person choose (flat, per point, by hand,
 * or off) are that spec's own work, and a missing setting means this number.
 */
export const MINUTES_PER_POINT = 10;

export interface Spend {
  cents: number;
  elapsedMs: number;
  attempts: number;
}

export const ZERO_SPEND: Spend = { cents: 0, elapsedMs: 0, attempts: 0 };

export type BudgetVerdict =
  | { ok: true; remainingCents: number }
  | { ok: false; reason: string; exceeded: "cost" | "time" | "attempts" };

export function checkBudget(spend: Spend, budget: Budget, billing: Billing = "metered"): BudgetVerdict {
  // Money only stops a metered run. A flat-rate plan is not billed per token,
  // and an id nobody has priced has no rate to hold a run to: stopping either
  // on cents would park a card on a number that does not exist. Time and
  // attempts are real for every run, so those ceilings always apply.
  if (billing === "metered" && spend.cents >= budget.maxCents) {
    return {
      ok: false,
      exceeded: "cost",
      reason: `Spend ceiling reached ($${(budget.maxCents / 100).toFixed(2)}).`,
    };
  }
  if (spend.elapsedMs >= budget.maxDurationMs) {
    return {
      ok: false,
      exceeded: "time",
      reason: `Ran out of time (${Math.round(budget.maxDurationMs / 60000)} minute budget).`,
    };
  }
  if (spend.attempts >= budget.maxAttempts) {
    return {
      ok: false,
      exceeded: "attempts",
      reason: `Retry ceiling reached (${budget.maxAttempts} attempts). "Flake" is not a root cause; this needs a human.`,
    };
  }
  return { ok: true, remainingCents: budget.maxCents - spend.cents };
}

/**
 * The advisory ceiling handed to the model so it paces itself and finishes
 * gracefully, rather than being cut off mid-edit by the hard cap above.
 * Deliberately below the hard limit: the hard cap is the backstop, not the
 * plan.
 */
export function taskBudgetTokens(budget: Budget, costPerMTokCents = 2500): number {
  const headroomCents = budget.maxCents * 0.8;
  const tokens = Math.floor((headroomCents / costPerMTokCents) * 1_000_000);
  // The API rejects a task budget below 20k tokens.
  return Math.max(20_000, tokens);
}

export function addSpend(a: Spend, b: Partial<Spend>): Spend {
  return {
    cents: a.cents + (b.cents ?? 0),
    elapsedMs: a.elapsedMs + (b.elapsedMs ?? 0),
    attempts: a.attempts + (b.attempts ?? 0),
  };
}

export interface ModelPrice {
  /** Cents per million input tokens. */
  in: number;
  /** Cents per million output tokens. */
  out: number;
}

interface PriceFamily {
  /** A model id in this family starts with this prefix, not just equals it: it also catches dated and versioned ids such as `claude-sonnet-5-20260101`. */
  prefix: string;
  provider: string;
  price: ModelPrice;
}

/**
 * List prices in cents per million tokens, one entry per model family, not
 * per exact id. New dated snapshots (`claude-sonnet-5-20260101`) and ids
 * pulled from a provider's live model list match their family by prefix.
 *
 * Only a starting point: what a provider charges is the provider's to tell us,
 * and CL-5 in docs/cline-audit.md is the work to read it from the metadata
 * they already publish instead of maintaining this by hand.
 */
const PRICE_FAMILIES: readonly PriceFamily[] = [
  // Anthropic
  { provider: "Anthropic", prefix: "claude-opus-5", price: { in: 500, out: 2500 } },
  { provider: "Anthropic", prefix: "claude-sonnet-5", price: { in: 200, out: 1000 } },
  { provider: "Anthropic", prefix: "claude-haiku-4-5", price: { in: 100, out: 500 } },
  { provider: "Anthropic", prefix: "claude-fable-5-1", price: { in: 1000, out: 5000 } },
  // OpenAI
  { provider: "OpenAI", prefix: "gpt-4o-mini", price: { in: 15, out: 60 } },
  { provider: "OpenAI", prefix: "gpt-4o", price: { in: 250, out: 1000 } },
  { provider: "OpenAI", prefix: "gpt-4.1-nano", price: { in: 10, out: 40 } },
  { provider: "OpenAI", prefix: "gpt-4.1-mini", price: { in: 40, out: 160 } },
  { provider: "OpenAI", prefix: "gpt-4.1", price: { in: 200, out: 800 } },
  { provider: "OpenAI", prefix: "o4-mini", price: { in: 110, out: 440 } },
  { provider: "OpenAI", prefix: "o3-mini", price: { in: 110, out: 440 } },
  { provider: "OpenAI", prefix: "o3", price: { in: 200, out: 800 } },
  { provider: "OpenAI", prefix: "gpt-5", price: { in: 500, out: 1500 } },
  // Google Gemini
  { provider: "Gemini", prefix: "gemini-2.5-flash-lite", price: { in: 10, out: 40 } },
  { provider: "Gemini", prefix: "gemini-2.5-flash", price: { in: 30, out: 250 } },
  { provider: "Gemini", prefix: "gemini-2.5-pro", price: { in: 125, out: 1000 } },
  { provider: "Gemini", prefix: "gemini-2.0-flash", price: { in: 10, out: 40 } },
  // DeepSeek. Peak rates; off-peak is half, and peak is only 01:00-04:00 and
  // 06:00-10:00 UTC on weekdays, so peak is the conservative end of the range.
  // The live ids are `deepseek-flash` (V4.1-Flash) and `deepseek-v4-pro`
  // (V4-Pro-0813); `deepseek-v4-flash` and its vision variant are legacy names
  // still billed at the Flash price.
  { provider: "DeepSeek", prefix: "deepseek-flash", price: { in: 30, out: 120 } },
  { provider: "DeepSeek", prefix: "deepseek-v4.1-flash", price: { in: 30, out: 120 } },
  { provider: "DeepSeek", prefix: "deepseek-v4-flash", price: { in: 30, out: 120 } },
  { provider: "DeepSeek", prefix: "deepseek-v4-pro", price: { in: 132, out: 396 } },
  // Groq
  { provider: "Groq", prefix: "llama-3.3-70b", price: { in: 59, out: 79 } },
  { provider: "Groq", prefix: "llama-3.1-8b", price: { in: 5, out: 8 } },
  { provider: "Groq", prefix: "mixtral-8x7b", price: { in: 24, out: 24 } },
  { provider: "Groq", prefix: "gemma2-9b", price: { in: 20, out: 20 } },
];

/**
 * How a run's model bills, which decides whether a dollar ceiling means
 * anything to it.
 *
 * - "metered": the provider charges per token and a family below knows what.
 *   The spend ceiling is money, so it applies.
 * - "flat": a subscription such as ClinePass, or the person's own plan behind a
 *   CLI agent. The next token costs nothing extra, so a dollar ceiling would
 *   measure a number nobody is billed. Time and attempt limits still apply.
 * - "unknown": nothing here has priced this id. Guessing a price and parking a
 *   card on the guess is worse than not guarding dollars at all — the run was
 *   stopped by a rate that does not exist — so an unpriced model is not charged
 *   against the ceiling either, and the agent editor says so.
 */
export type Billing = "metered" | "flat" | "unknown";

function matchFamily(model: string): PriceFamily | undefined {
  // OpenRouter ids are "vendor/model" (e.g. "openai/gpt-4o"); the part after
  // the slash matches the same families as calling that vendor directly.
  const candidates = model.includes("/") ? [model, model.slice(model.indexOf("/") + 1)] : [model];
  let best: PriceFamily | undefined;
  for (const candidate of candidates) {
    for (const family of PRICE_FAMILIES) {
      if (candidate.startsWith(family.prefix)) {
        if (!best || family.prefix.length > best.prefix.length) best = family;
      }
    }
  }
  return best;
}

/**
 * How this run bills: the provider decides when we know it, the model id
 * otherwise. The provider wins, because ClinePass serves model ids that look
 * exactly like calling DeepSeek directly, and only one of the two is a
 * subscription.
 */
export function billingFor(model: string | null | undefined, providerId?: string | null): Billing {
  if (providerId && providerInfo(providerId as ProviderId)?.flatRate) return "flat";
  if (!model || !matchFamily(model)) return "unknown";
  return "metered";
}

export interface ModelPricing {
  /** Cents per million tokens. Zero when nothing is billed per token. */
  price: ModelPrice;
  /** Whether the spend ceiling may stop a run on money at all. */
  billing: Billing;
  /** False when this is an id nobody has priced. */
  known: boolean;
  /** The matched family's provider, only set when a family matched. */
  provider?: string;
  /** The matched family's prefix, only set when a family matched. */
  family?: string;
}

export function priceForModel(model: string, providerId?: string | null): ModelPricing {
  const billing = billingFor(model, providerId);
  const family = billing === "flat" ? undefined : matchFamily(model);
  if (family) return { price: family.price, billing, known: true, provider: family.provider, family: family.prefix };
  return { price: { in: 0, out: 0 }, billing, known: billing !== "unknown" };
}

/** What the agent editor tells someone about how this model is charged. */
export function pricingNote(model: string, providerId?: string | null): string {
  const { billing, provider, family } = priceForModel(model, providerId);
  if (billing === "metered") return `Billed as ${provider} ${family} for the spend ceiling.`;
  if (billing === "flat") {
    return "Flat-rate plan: tokens cost nothing extra here, so a run is bounded by its time and attempt limits rather than by a spend ceiling.";
  }
  return `No price known for "${model}", so it is not counted against the spend ceiling. Its runs are bounded by their time and attempt limits instead.`;
}

/**
 * What these tokens cost, in cents. Zero when nothing is billed per token: a
 * flat-rate plan is not charged per token, and an id nobody has priced is not
 * charged a guess. The ceiling counts money, so inventing a number would park
 * runs on a rate that does not exist.
 */
export function estimateCostCents(
  model: string,
  tokensIn: number,
  tokensOut: number,
  providerId?: string | null,
): number {
  const { price, billing } = priceForModel(model, providerId);
  if (billing !== "metered") return 0;
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
}
