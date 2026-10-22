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

const { PUT } = await import("./route");

function put(body: unknown): Request {
  return new Request("http://localhost/api/agents/presets/x/allowance", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let presetId: string;
let otherPresetId: string;

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
  const other = await repo.upsertUser({ githubId: 2, login: "b", name: null, avatarUrl: null });
  const base = { provider: "anthropic" as const, name: "Coder", model: "claude-opus-5", prompt: "p" };
  presetId = (await repo.savePreset({ ...base, ownerId: user.id })).id;
  otherPresetId = (await repo.savePreset({ ...base, ownerId: other.id })).id;
});

describe("PUT /api/agents/presets/[id]/allowance", () => {
  it("stores the allowance with the default 30-day window", async () => {
    const res = await PUT(put({ tokens: 1000 }), ctx(presetId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokens: 1000, windowDays: 30 });
  });

  it("clears the allowance with null tokens", async () => {
    await PUT(put({ tokens: 1000, windowDays: 7 }), ctx(presetId));
    expect((await (await PUT(put({ tokens: null }), ctx(presetId))).json()).tokens).toBeNull();
  });

  it("rejects an unknown field and a bad window", async () => {
    expect((await PUT(put({ tokens: 1, cents: 2 }), ctx(presetId))).status).toBe(400);
    expect((await PUT(put({ tokens: 1, windowDays: 0 }), ctx(presetId))).status).toBe(400);
  });

  it("answers 404 for another person's preset", async () => {
    expect((await PUT(put({ tokens: 1 }), ctx(otherPresetId))).status).toBe(404);
  });

  it("asks to sign in when there is no session", async () => {
    jar.clear();
    expect((await PUT(put({ tokens: 1 }), ctx(presetId))).status).toBe(401);
  });
});
