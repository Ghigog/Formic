import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The cookies the next request carries. Stands in for Next's request scope. */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
}));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, signSession } = await import("./session");
const { PROJECT_COOKIE, activeProject } = await import("@/lib/board/project");
const { savePreset, agentConfigFor } = await import("@/lib/agents/presets");
const presetRoute = await import("@/app/api/agents/presets/[id]/route");
const columnRoute = await import("@/app/api/agents/columns/[column]/route");
const agentsRoute = await import("@/app/api/agents/route");
const { seal } = await import("@/lib/secrets/vault");
const { resetEnvCache } = await import("@/lib/secrets/env");

async function person(githubId: number, login: string) {
  return repository().upsertUser({ githubId, login, name: null, avatarUrl: null });
}

async function actAs(userId: string, projectId?: string) {
  jar.clear();
  jar.set(SESSION_COOKIE, await signSession(userId));
  if (projectId) jar.set(PROJECT_COOKIE, projectId);
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("one person's board is not another's", () => {
  it("ignores a project cookie pointing at someone else's board", async () => {
    const alice = await person(1, "alice");
    const bob = await person(2, "bob");
    const hers = await repository().ensureProject({ ownerId: alice.id, repoFullName: "a/x", baseBranch: "main" });

    await actAs(bob.id, hers.id);
    expect(await activeProject()).toBeNull();

    await actAs(alice.id, hers.id);
    expect((await activeProject())?.id).toBe(hers.id);
  });

  it("does not show a signed-in person the ownerless demo board", async () => {
    await repository().defaultProject();
    const bob = await person(2, "bob");
    await actAs(bob.id);
    expect(await activeProject()).toBeNull();
  });

  it("will not let anyone edit, delete or assign another person's agent", async () => {
    const alice = await person(1, "alice");
    const bob = await person(2, "bob");
    const bobs = await repository().ensureProject({ ownerId: bob.id, repoFullName: "b/y", baseBranch: "main" });
    const preset = await savePreset({ ownerId: alice.id, name: "hers", model: "claude-opus-5", prompt: "p" });

    await actAs(bob.id, bobs.id);
    const params = { params: Promise.resolve({ id: preset.id }) };
    const body = JSON.stringify({ name: "mine now", model: "claude-opus-5", prompt: "p" });
    expect((await presetRoute.PATCH(new Request("http://x", { method: "PATCH", body }), params)).status).toBe(404);
    expect((await presetRoute.DELETE(new Request("http://x"), params)).status).toBe(404);
    const assign = await columnRoute.PUT(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ presetId: preset.id }) }),
      { params: Promise.resolve({ column: "in_progress" }) },
    );
    expect(assign.status).toBe(404);

    const listed = (await (await agentsRoute.GET()).json()) as { presets: unknown[] };
    expect(listed.presets).toEqual([]);
  });

  it("runs a board's built-in agents on its owner's Anthropic key", async () => {
    const alice = await person(1, "alice");
    await repository().updateUser(alice.id, { anthropicKeyCipher: seal("sk-ant-alice") });
    const hers = await repository().ensureProject({ ownerId: alice.id, repoFullName: "a/x", baseBranch: "main" });

    expect(await agentConfigFor(hers.id, "todo")).toEqual({ apiKey: "sk-ant-alice" });
  });
});

describe("the allowlist", () => {
  it("signs someone out as soon as they are taken off it", async () => {
    const { currentUser } = await import("./user");
    const alice = await person(1, "alice");
    await actAs(alice.id);
    expect((await currentUser())?.id).toBe(alice.id);

    vi.stubEnv("FORMIC_ALLOWED_USERS", "bob");
    expect(await currentUser()).toBeNull();
  });
});
