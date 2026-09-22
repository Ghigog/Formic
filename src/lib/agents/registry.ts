import type { AgentRegistry } from "./ports";
import {
  AnthropicArchitectAgent,
  AnthropicProductAgent,
  AnthropicShowcaseAgent,
} from "./anthropic";
import { AnthropicCoderAgent, AnthropicReviewerAgent } from "./coder";
import {
  MockArchitectAgent,
  MockCoderAgent,
  MockProductAgent,
  MockReviewerAgent,
  MockShowcaseAgent,
} from "./mock";

/**
 * The one place a mock is swapped for the real thing. Real agents are
 * registered here by PROT-03, PROT-04 and PROT-08; until an ANTHROPIC_API_KEY
 * is present the board runs entirely on mocks.
 */

let cached: AgentRegistry | null = null;

export function useMockAgents(): boolean {
  if (process.env.AGENT_PROVIDER === "mock") return true;
  if (process.env.AGENT_PROVIDER === "anthropic") return false;
  return !process.env.ANTHROPIC_API_KEY;
}

export function agents(): AgentRegistry {
  if (cached) return cached;

  if (useMockAgents()) {
    cached = {
      product: new MockProductAgent(),
      architect: new MockArchitectAgent(),
      coder: new MockCoderAgent(),
      reviewer: new MockReviewerAgent(),
      showcase: new MockShowcaseAgent(),
    };
    return cached;
  }

  cached = {
    product: new AnthropicProductAgent(),
    architect: new AnthropicArchitectAgent(),
    coder: new AnthropicCoderAgent(),
    reviewer: new AnthropicReviewerAgent(),
    showcase: new AnthropicShowcaseAgent(),
  };
  return cached;
}

export function setAgents(registry: AgentRegistry): void {
  cached = registry;
}

/** Test seam. */
export function resetAgents(): void {
  cached = null;
}
