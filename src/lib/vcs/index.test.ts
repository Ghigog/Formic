import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/secrets/env";
import { resetVcs, usingMockVcs, vcs } from "./index";

/**
 * Mock agents are self-contained: with `AGENT_PROVIDER=mock` the GitHub layer
 * is mocked too, so a mock run cannot reach a real repository however a token
 * happens to be lying around in the environment.
 */

beforeEach(() => {
  resetVcs();
  vi.stubEnv("FORMIC_SECRET", "test");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetVcs();
  resetEnvCache();
});

describe("the GitHub layer under mock agents", () => {
  it("is mocked whatever token the process holds", () => {
    vi.stubEnv("AGENT_PROVIDER", "mock");
    vi.stubEnv("GITHUB_TOKEN", "ghp_a_real_token");
    resetEnvCache();
    expect(usingMockVcs()).toBe(true);
    expect(vcs("acme/widgets", "ghp_a_real_token").name).toBe("mock");
  });

  it("uses a real token when agents are not mocked", () => {
    vi.stubEnv("AGENT_PROVIDER", "anthropic");
    vi.stubEnv("GITHUB_TOKEN", "ghp_a_real_token");
    resetEnvCache();
    expect(usingMockVcs()).toBe(false);
    expect(vcs("acme/widgets", "ghp_a_real_token").name).toBe("github");
  });

  it("is mocked with no token at all, so the board still runs", () => {
    vi.stubEnv("AGENT_PROVIDER", "anthropic");
    vi.stubEnv("GITHUB_TOKEN", "");
    resetEnvCache();
    expect(usingMockVcs()).toBe(true);
    expect(vcs("acme/widgets", null).name).toBe("mock");
  });
});
