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
import { mockAgentsEnabled } from "./mock-mode";

/**
 * The one place a mock is swapped for the real thing. Real agents are
 * registered here by PROT-03, PROT-04 and PROT-08.
 *
 * Mocks are a development and test affordance, and are only used when
 * `AGENT_PROVIDER=mock` asks for them (see ./mock-mode). A board a person is
 * using never runs on a mock: a column with no agent stops and asks for one,
 * handled in `resolveColumn` (./presets) rather than here.
 */

let cached: AgentRegistry | null = null;
/** Set by tests through setAgents: then nothing else chooses the agents. */
let overridden = false;

export function agentsOverridden(): boolean {
  return overridden;
}

export function usingMockAgents(): boolean {
  return mockAgentsEnabled();
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
