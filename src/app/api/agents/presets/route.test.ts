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

const { POST } = await import("./route");

const valid = { provider: "anthropic", name: "Coder", model: "claude-opus-5", prompt: "p" };

function post(body: unknown): Request {
  return new Request("http://localhost/api/agents/presets", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(async () => {
  globalThis.__formicMemoryStore = undefined;
  jar.clear();
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("FORMIC_ALLOWED_USERS", "");
  resetEnvCache();
  const user = await repository().upsertUser({ githubId: 1, login: "a", name: null, avatarUrl: null });
  jar.set(SESSION_COOKIE, await signSession(user.id));
});

describe("POST /api/agents/presets", () => {
  it("saves a preset owned by the signed-in person", async () => {
    const res = await POST(post(valid));
    expect(res.status).toBe(201);
    expect((await res.json()).preset).toMatchObject({ name: "Coder", model: "claude-opus-5" });
  });

  it.each([[null], [{}], [{ ...valid, name: "" }]])("rejects a malformed body %j", async (body) => {
    expect((await POST(post(body))).status).toBe(400);
  });

  it("asks to sign in when there is no session", async () => {
    jar.clear();
    expect((await POST(post(valid))).status).toBe(401);
  });
});
