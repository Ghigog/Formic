import { afterEach, describe, expect, it, vi } from "vitest";
import { configWarnings, env, resetEnvCache } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("env", () => {
  it("drops a malformed optional value and reports it instead of throwing", () => {
    vi.stubEnv("GITHUB_REPO", "not a repo");
    vi.stubEnv("SANDBOX_PROVIDER", "docker");
    vi.stubEnv("GITHUB_TOKEN", "ghp_x");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = env();

    expect(config.GITHUB_REPO).toBeUndefined();
    expect(config.SANDBOX_PROVIDER).toBe("local");
    expect(config.GITHUB_TOKEN).toBe("ghp_x");
    expect(configWarnings()).toHaveLength(2);
    expect(configWarnings().join(" ")).toMatch(/GITHUB_REPO.*SANDBOX_PROVIDER|SANDBOX_PROVIDER.*GITHUB_REPO/);
  });

  it("normalizes the repo forms people paste", () => {
    vi.stubEnv("GITHUB_REPO", '"https://github.com/Ghigog/Formic.git"');
    expect(env().GITHUB_REPO).toBe("Ghigog/Formic");
    expect(configWarnings()).toEqual([]);
  });

  it("strips quotes pasted from .env.example", () => {
    vi.stubEnv("MERGE_TARGET", '"base"');
    expect(env().MERGE_TARGET).toBe("base");
  });
});
