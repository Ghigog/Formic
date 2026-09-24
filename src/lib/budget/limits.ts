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

export interface Budget {
  /** Hard ceiling on spend for this scope, in cents. */
  maxCents: number;
  /** Wall-clock ceiling in milliseconds. */
  maxDurationMs: number;
  /** How many times a failing step may be retried. */
  maxAttempts: number;
}

export const DEFAULT_RUN_BUDGET: Budget = {
  maxCents: 200,
  maxDurationMs: 15 * 60 * 1000,
  maxAttempts: 3,
};

export const DEFAULT_EPIC_BUDGET: Budget = {
  maxCents: 2_000,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxAttempts: 12,
};

export interface Spend {
  cents: number;
  elapsedMs: number;
  attempts: number;
}

export const ZERO_SPEND: Spend = { cents: 0, elapsedMs: 0, attempts: 0 };

export type BudgetVerdict =
  | { ok: true; remainingCents: number }
  | { ok: false; reason: string; exceeded: "cost" | "time" | "attempts" };

export function checkBudget(spend: Spend, budget: Budget): BudgetVerdict {
  if (spend.cents >= budget.maxCents) {
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
      reason: `Time ceiling reached (${Math.round(budget.maxDurationMs / 60000)} minutes).`,
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
 * pulled from a provider's live model list match their family by prefix
 * instead of falling through to free.
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
  // DeepSeek
  { provider: "DeepSeek", prefix: "deepseek-reasoner", price: { in: 55, out: 219 } },
  { provider: "DeepSeek", prefix: "deepseek-chat", price: { in: 27, out: 110 } },
  // Groq
  { provider: "Groq", prefix: "llama-3.3-70b", price: { in: 59, out: 79 } },
  { provider: "Groq", prefix: "llama-3.1-8b", price: { in: 5, out: 8 } },
  { provider: "Groq", prefix: "mixtral-8x7b", price: { in: 24, out: 24 } },
  { provider: "Groq", prefix: "gemma2-9b", price: { in: 20, out: 20 } },
];

/**
 * Charged to a model that matches no family above, such as an OpenRouter id
 * for a model nobody has priced here yet. Set to the priciest family known,
 * on purpose: an unpriced model is assumed expensive, not free, so it still
 * trips the run and Epic ceilings instead of running unmetered.
 */
const CONSERVATIVE_DEFAULT_PRICE: ModelPrice = PRICE_FAMILIES.reduce(
  (max, family) => (family.price.out > max.out ? family.price : max),
  { in: 0, out: 0 } as ModelPrice,
);

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

export interface ModelPricing {
  price: ModelPrice;
  /** False when the id matched no known family, and the conservative default is used instead. */
  known: boolean;
  /** The matched family's provider, only set when known. */
  provider?: string;
  /** The matched family's prefix, only set when known. */
  family?: string;
}

export function priceForModel(model: string): ModelPricing {
  const family = matchFamily(model);
  if (family) return { price: family.price, known: true, provider: family.provider, family: family.prefix };
  return { price: CONSERVATIVE_DEFAULT_PRICE, known: false };
}

/** How the agent editor tells someone what an unpriced model will cost. */
export function pricingNote(model: string): string {
  const { known, provider, family } = priceForModel(model);
  if (known) return `Billed as ${provider} ${family} for the spend ceiling.`;
  return (
    `No known price for "${model}". It will be charged against the spend ceiling at a conservative ` +
    `default of $${(CONSERVATIVE_DEFAULT_PRICE.in / 100).toFixed(2)} / $${(CONSERVATIVE_DEFAULT_PRICE.out / 100).toFixed(2)} ` +
    `per million tokens (in/out) until it is priced by name.`
  );
}

export function estimateCostCents(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const { price } = priceForModel(model);
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
}
