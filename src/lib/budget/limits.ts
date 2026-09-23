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

/** Anthropic list prices in cents per million tokens. */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 500, out: 2500 },
  "claude-sonnet-5": { in: 200, out: 1000 },
  "claude-haiku-4-5": { in: 100, out: 500 },
  "claude-fable-5-1": { in: 1000, out: 5000 },
};

export function estimateCostCents(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
}

export function knownModels(): string[] {
  return Object.keys(PRICING);
}
