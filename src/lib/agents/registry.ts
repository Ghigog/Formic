import type { AgentRegistry } from "./ports";
import {
  AnthropicArchitectAgent,
  AnthropicProductAgent,
  AnthropicShowcaseAgent,
} from "./anthropic";
import { LoopCoderAgent, LoopReviewerAgent } from "./coder";
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
/** Set by tests through setAgents: then nothing else chooses the agents. */
let overridden = false;

export function agentsOverridden(): boolean {
  return overridden;
}

export function usingMockAgents(): boolean {
  if (process.env.AGENT_PROVIDER === "mock") return true;
  if (process.env.AGENT_PROVIDER === "anthropic") return false;
  return !process.env.ANTHROPIC_API_KEY;
}

export function agents(): AgentRegistry {
  if (cached) return cached;

  if (usingMockAgents()) {
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
    coder: new LoopCoderAgent(),
    reviewer: new LoopReviewerAgent(),
    showcase: new AnthropicShowcaseAgent(),
  };
  return cached;
}

export function setAgents(registry: AgentRegistry): void {
  cached = registry;
  overridden = true;
}

/** Test seam. */
export function resetAgents(): void {
  cached = null;
  overridden = false;
}
