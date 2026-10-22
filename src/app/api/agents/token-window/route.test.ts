import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, signSession } = await import("@/lib/auth/session");
const { PROJECT_COOKIE } = await import("@/lib/board/project");
const { resetEnvCache } = await import("@/lib/secrets/env");

const { POST } = await import("./route");

beforeEach(async () => {
  globalThis.__formicMemoryStore = undefined;
  jar.clear();
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("FORMIC_ALLOWED_USERS", "");
  resetEnvCache();
  const repo = repository();
  const user = await repo.upsertUser({ githubId: 1, login: "a", name: null, avatarUrl: null });
  jar.set(SESSION_COOKIE, await signSession(user.id));
  const project = await repo.ensureProject({ ownerId: user.id, repoFullName: "a/board", baseBranch: "main" });
  jar.set(PROJECT_COOKIE, project.id);
});

describe("POST /api/agents/token-window", () => {
  it("stamps a reset for the signed-in person", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const { resetAt } = await res.json();
    expect(Number.isNaN(Date.parse(resetAt))).toBe(false);
  });

  it("asks to sign in when there is no session", async () => {
    jar.clear();
    expect((await POST()).status).toBe(401);
  });
});
