import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Stands in for Next's request scope; see src/lib/auth/isolation.test.ts. */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, signSession } = await import("@/lib/auth/session");
const { seal } = await import("@/lib/secrets/vault");
const { resetEnvCache } = await import("@/lib/secrets/env");
const { DELETE } = await import("./route");

async function actAs(userId: string) {
  jar.clear();
  jar.set(SESSION_COOKIE, await signSession(userId));
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  jar.clear();
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("FORMIC_ALLOWED_USERS", "");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe("DELETE /api/account", () => {
  it("refuses an unauthenticated request", async () => {
    const res = await DELETE(request({ confirm: true }));
    expect(res.status).toBe(401);
  });

  it("deletes nothing when the request does not confirm", async () => {
    const user = await repository().upsertUser({ githubId: 1, login: "a", name: null, avatarUrl: null });
    await actAs(user.id);

    const res = await DELETE(request({}));

    expect(res.status).toBe(400);
    expect(await repository().userById(user.id)).not.toBeNull();
  });

  it("signs the person out, removes everything they own, and revokes their GitHub token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    });

    const user = await repository().upsertUser({ githubId: 2, login: "b", name: null, avatarUrl: null });
    await repository().updateUser(user.id, { githubTokenCipher: seal("ghu_secret") });
    const project = await repository().ensureProject({
      ownerId: user.id,
      repoFullName: "a/b",
      baseBranch: "main",
    });
    const card = await repository().createEpic({
      projectId: project.id,
      title: "A board",
      rawRequest: "do the thing",
      position: 1,
    });
    const preset = await repository().savePreset({
      ownerId: user.id,
      provider: "anthropic",
      name: "Saved agent",
      model: "claude-opus-5",
      prompt: "be helpful",
    });
    await actAs(user.id);

    const res = await DELETE(request({ confirm: true }));

    expect(res.status).toBe(200);
    expect(await repository().userById(user.id)).toBeNull();
    expect(await repository().projectById(project.id)).toBeNull();
    expect(await repository().cardById(card.id)).toBeNull();
    expect(await repository().listPresets({ ownerId: user.id, includeUnowned: false })).toEqual([]);
    expect(await repository().presetForRun(preset.id)).toBeNull();

    const revoke = calls.find((c) => c.url.includes("/applications/"));
    expect(revoke).toBeDefined();
    expect(JSON.parse(String(revoke?.init?.body))).toEqual({ access_token: "ghu_secret" });

    const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cleared).toContain("Max-Age=0");
  });
});
