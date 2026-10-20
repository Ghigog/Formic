import { afterEach, describe, expect, it, vi } from "vitest";

import { E2BSandboxProvider } from "./e2b";
import { LOCAL_SANDBOX_ON_VERCEL, sandboxProvider } from "./index";
import { LocalSandboxProvider } from "./local";
import { resetEnvCache } from "@/lib/secrets/env";

/**
 * The provider selector reads SANDBOX_PROVIDER (defaulting to local) and
 * refuses the local provider on Vercel.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("sandboxProvider", () => {
  it("returns the E2B provider when SANDBOX_PROVIDER is e2b", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "e2b");
    expect(sandboxProvider()).toBeInstanceOf(E2BSandboxProvider);
  });

  it("returns the local provider when SANDBOX_PROVIDER is local", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "local");
    vi.stubEnv("VERCEL", "");
    expect(sandboxProvider()).toBeInstanceOf(LocalSandboxProvider);
  });

  it("falls back to the local provider when SANDBOX_PROVIDER is unset", () => {
    vi.stubEnv("SANDBOX_PROVIDER", undefined);
    vi.stubEnv("VERCEL", "");
    expect(sandboxProvider()).toBeInstanceOf(LocalSandboxProvider);
  });

  it("refuses the local provider on Vercel", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "local");
    vi.stubEnv("VERCEL", "1");
    expect(() => sandboxProvider()).toThrow(LOCAL_SANDBOX_ON_VERCEL);
  });

  it("still returns E2B on Vercel", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "e2b");
    vi.stubEnv("VERCEL", "1");
    expect(sandboxProvider()).toBeInstanceOf(E2BSandboxProvider);
  });
});
