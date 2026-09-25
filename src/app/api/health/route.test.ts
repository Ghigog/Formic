import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { resetEnvCache } from "@/lib/secrets/env";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("/api/health", () => {
  it("is ok in local mode with no FORMIC_SECRET", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.warnings).not.toContainEqual(expect.stringMatching(/FORMIC_SECRET/));
  });

  it("reports ok: false in GitHub mode with no FORMIC_SECRET", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.warnings).toContainEqual(expect.stringMatching(/FORMIC_SECRET is not set/));
  });

  it("is ok in GitHub mode with a FORMIC_SECRET of at least 32 bytes", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    vi.stubEnv("FORMIC_SECRET", "a".repeat(32));
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
