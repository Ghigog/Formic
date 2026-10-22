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

const { PATCH, DELETE } = await import("./route");

const valid = { provider: "anthropic", name: "Renamed", model: "claude-opus-5", prompt: "p" };

function patch(body: unknown): Request {
  return new Request("http://localhost/api/agents/presets/x", { method: "PATCH", body: JSON.stringify(body) });
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
  const other = await repo.upsertUser({ githubId: 2, login: "b", name: null, avatarUrl: null });
  jar.set(SESSION_COOKIE, await signSession(user.id));
  const base = { provider: "anthropic" as const, name: "Coder", model: "claude-opus-5", prompt: "p" };
  presetId = (await repo.savePreset({ ...base, ownerId: user.id })).id;
  otherPresetId = (await repo.savePreset({ ...base, ownerId: other.id })).id;
});

describe("PATCH /api/agents/presets/[id]", () => {
  it("updates the person's own preset", async () => {
    const res = await PATCH(patch(valid), ctx(presetId));
    expect(res.status).toBe(200);
    expect((await res.json()).preset).toMatchObject({ id: presetId, name: "Renamed" });
  });

  it("rejects a malformed body", async () => {
    expect((await PATCH(patch({ name: "" }), ctx(presetId))).status).toBe(400);
  });

  it("answers 404 for another person's preset and for an unknown id", async () => {
    expect((await PATCH(patch(valid), ctx(otherPresetId))).status).toBe(404);
    expect((await PATCH(patch(valid), ctx("nope"))).status).toBe(404);
  });

  it("asks to sign in when there is no session", async () => {
    jar.clear();
    expect((await PATCH(patch(valid), ctx(presetId))).status).toBe(401);
  });
});

describe("DELETE /api/agents/presets/[id]", () => {
  it("deletes the person's own preset", async () => {
    const res = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx(presetId));
    expect(res.status).toBe(204);
    expect(await repository().presetForRun(presetId)).toBeFalsy();
  });

  it("answers 404 for another person's preset and leaves it", async () => {
    const res = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx(otherPresetId));
    expect(res.status).toBe(404);
    expect(await repository().presetForRun(otherPresetId)).toBeTruthy();
  });

  it("asks to sign in when there is no session", async () => {
    jar.clear();
    expect((await DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx(presetId))).status).toBe(401);
  });
});
