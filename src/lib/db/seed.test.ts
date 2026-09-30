import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSeedAllowed } from "./seed";

function githubMode() {
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.x");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "secret");
}

describe("demoSeedAllowed", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows seeding in local mode outside production", () => {
    expect(demoSeedAllowed()).toBe(true);
  });

  it("refuses in production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(demoSeedAllowed()).toBe(false);
  });

  it("refuses in GitHub mode", () => {
    githubMode();
    expect(demoSeedAllowed()).toBe(false);
  });

  it("allows production and GitHub mode when FORMIC_SEED_DEMO=1", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    githubMode();
    vi.stubEnv("FORMIC_SEED_DEMO", "1");
    expect(demoSeedAllowed()).toBe(true);
  });
});
