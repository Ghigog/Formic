import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, signSession } = await import("@/lib/auth/session");
const { resetEnvCache } = await import("@/lib/secrets/env");
const { GET } = await import("./route");
const { POST } = await import("./token-window/route");

let userId: string;

beforeEach(async () => {
  globalThis.__formicMemoryStore = undefined;
  jar.clear();
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("FORMIC_ALLOWED_USERS", "");
  resetEnvCache();
  const user = await repository().upsertUser({ githubId: 1, login: "a", name: null, avatarUrl: null });
  userId = user.id;
  jar.set(SESSION_COOKIE, await signSession(userId));
});

describe("/api/agents token window", () => {
  it("reads all time with nothing set", async () => {
    expect((await (await GET()).json()).window).toEqual({ kind: "all-time", since: null, timezone: null });
  });

  it("reads the renewal window in the stored timezone", async () => {
    await repository().updateTokenRenewal(userId, { tokenRenewalDay: 5, tokenWindowTimezone: "UTC" });
    const { window } = await (await GET()).json();
    expect(window.kind).toBe("renewal");
    expect(window.timezone).toBe("UTC");
    expect(new Date(window.since).getUTCDate()).toBe(5);
  });

  it("stamps a reset for the current user, which the next read reports", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const { window } = await (await GET()).json();
    expect(window.kind).toBe("reset");
    expect(window.since).toBe((await res.json()).resetAt);
  });

  it("refuses a reset when nobody is signed in", async () => {
    jar.clear();
    expect((await POST()).status).toBe(401);
  });
});
