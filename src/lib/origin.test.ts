import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredOrigin, publicUrl } from "./origin";

afterEach(() => vi.unstubAllEnvs());

const behindProxy = new Request("https://localhost:3000/api/auth/github/login");

describe("publicUrl", () => {
  it("uses FORMIC_URL over the address the server listens on", () => {
    vi.stubEnv("FORMIC_URL", "https://52-200-209-60.sslip.io/");
    expect(publicUrl("/api/auth/github/callback", behindProxy).toString()).toBe(
      "https://52-200-209-60.sslip.io/api/auth/github/callback",
    );
  });

  it("falls back to the request's own origin when FORMIC_URL is unset", () => {
    vi.stubEnv("FORMIC_URL", "");
    expect(publicUrl("/login", behindProxy).toString()).toBe("https://localhost:3000/login");
  });
});

describe("configuredOrigin", () => {
  it("is null for a blank value", () => {
    vi.stubEnv("FORMIC_URL", "  ");
    expect(configuredOrigin()).toBeNull();
  });
});
