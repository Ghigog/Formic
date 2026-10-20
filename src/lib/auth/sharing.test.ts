import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The cookies the next request carries. Stands in for Next's request scope. */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
}));
/** Every signed-in person's GitHub access reaches every repository here. */
vi.mock("./github", async (original) => ({
  ...(await original<typeof import("./github")>()),
  githubTokenFor: async () => "gh-token",
}));
vi.mock("@/lib/vcs/repositories", async (original) => ({
  ...(await original<typeof import("@/lib/vcs/repositories")>()),
  getRepository: async (fullName: string) => ({ fullName, defaultBranch: "main" }),
}));
vi.mock("@/lib/agents/pipeline", async (original) => ({
  ...(await original<typeof import("@/lib/agents/pipeline")>()),
  launch: () => undefined,
}));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, signSession } = await import("./session");
const { PROJECT_COOKIE, activeProject } = await import("@/lib/board/project");
const { savePreset, agentConfigFor } = await import("@/lib/agents/presets");
const { credentialsForProject } = await import("./credentials");
const { withActor, withCardActor } = await import("./actor");
const { seal } = await import("@/lib/secrets/vault");
const { resetEnvCache } = await import("@/lib/secrets/env");
const projectsRoute = await import("@/app/api/projects/route");
const settingsRoute = await import("@/app/api/settings/route");

async function person(githubId: number, login: string) {
  return repository().upsertUser({ githubId, login, name: null, avatarUrl: null });
}

async function actAs(userId: string, projectId?: string) {
  jar.clear();
  jar.set(SESSION_COOKIE, await signSession(userId));
  if (projectId) jar.set(PROJECT_COOKIE, projectId);
}

async function agent(ownerId: string, name: string) {
  return savePreset({ ownerId, name, provider: "anthropic", model: "claude-opus-5", prompt: "", apiKey: `sk-${name}` });
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("E2B_API_KEY", "");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

/** Alice's board on acme/app, and Bob, who can reach acme/app too. */
async function aliceAndBob() {
  const alice = await person(1, "alice");
  const bob = await person(2, "bob");
  const board = await repository().ensureProject({ ownerId: alice.id, repoFullName: "acme/app", baseBranch: "main" });
  await repository().updateUser(alice.id, { e2bKeyCipher: seal("e2b_alice"), e2bKeyHint: "lice" });
  return { alice, bob, board };
}

describe("one board per repository", () => {
  it("joins the board someone already has, instead of making another", async () => {
    const { bob, board } = await aliceAndBob();
    await actAs(bob.id);

    const res = await projectsRoute.POST(
      new (await import("next/server")).NextRequest("http://x/api/projects", {
        method: "POST",
        body: JSON.stringify({ repoFullName: "acme/app" }),
      }),
    );

    expect(((await res.json()) as { project: { id: string } }).project.id).toBe(board.id);
    expect(await repository().isMember(board.id, bob.id)).toBe(true);
    expect((await repository().projectsForRepo("acme/app")).length).toBe(1);
  });

  it("shows a member the shared board, with every card on it", async () => {
    const { bob, board } = await aliceAndBob();
    await repository().addMember(board.id, bob.id);

    await actAs(bob.id, board.id);
    expect((await activeProject())?.id).toBe(board.id);
  });

  it("moves someone off a board of their own onto the one that came first", async () => {
    const { bob, board } = await aliceAndBob();
    const his = await repository().ensureProject({ ownerId: bob.id, repoFullName: "acme/app", baseBranch: "main" });

    await actAs(bob.id, his.id);
    expect((await activeProject())?.id).toBe(board.id);

    const listed = (await (await projectsRoute.GET()).json()) as { projects: Array<{ id: string }> };
    expect(listed.projects.map((p) => p.id)).toEqual([board.id]);
  });

  it("still keeps out anyone it is not shared with", async () => {
    const { bob, board } = await aliceAndBob();
    await actAs(bob.id, board.id);
    expect(await activeProject()).toBeNull();
  });
});

describe("each person's work runs on their own keys", () => {
  it("gives a member their own sandbox key, and the owner's only when she shares", async () => {
    const { bob, board } = await aliceAndBob();
    await repository().addMember(board.id, bob.id);

    expect((await credentialsForProject(board)).e2bKey).toBe("e2b_alice");
    expect((await withActor(bob.id, () => credentialsForProject(board))).e2bKey).toBeFalsy();

    await repository().setShareKeys(board.id, true);
    const shared = (await repository().projectById(board.id))!;
    expect((await withActor(bob.id, () => credentialsForProject(shared))).e2bKey).toBe("e2b_alice");

    await repository().updateUser(bob.id, { e2bKeyCipher: seal("e2b_bob"), e2bKeyHint: "_bob" });
    expect((await withActor(bob.id, () => credentialsForProject(shared))).e2bKey).toBe("e2b_bob");
  });

  it("runs a member's agent, never the owner's unless she shares", async () => {
    const { alice, bob, board } = await aliceAndBob();
    await repository().addMember(board.id, bob.id);
    const hers = await agent(alice.id, "hers");
    await repository().setColumnAgent(board.id, "in_progress", hers.id);

    expect((await agentConfigFor(board.id, "in_progress"))?.apiKey).toBe("sk-hers");
    expect(await withActor(bob.id, () => agentConfigFor(board.id, "in_progress"))).toBeNull();

    await repository().setShareKeys(board.id, true);
    expect((await withActor(bob.id, () => agentConfigFor(board.id, "in_progress")))?.apiKey).toBe("sk-hers");

    const his = await agent(bob.id, "his");
    await repository().setMemberAgent(board.id, bob.id, "in_progress", his.id);
    expect((await withActor(bob.id, () => agentConfigFor(board.id, "in_progress")))?.apiKey).toBe("sk-his");
    expect((await agentConfigFor(board.id, "in_progress"))?.apiKey).toBe("sk-hers");
  });

  it("keeps running a card on the keys of whoever set it going, after their request", async () => {
    const { bob, board } = await aliceAndBob();
    await repository().addMember(board.id, bob.id);
    await repository().updateUser(bob.id, { e2bKeyCipher: seal("e2b_bob"), e2bKeyHint: "_bob" });
    const epic = await repository().createEpic({ projectId: board.id, title: "His", rawRequest: "His", position: 1 });
    await repository().setCardActor(epic.id, bob.id);

    expect((await withCardActor(epic.id, () => credentialsForProject(board))).e2bKey).toBe("e2b_bob");
  });
});

describe("the owner's sharing switch", () => {
  it("is the owner's alone", async () => {
    const { alice, bob, board } = await aliceAndBob();
    await repository().addMember(board.id, bob.id);
    const put = (body: unknown) =>
      settingsRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }));

    await actAs(bob.id, board.id);
    expect((await put({ projectId: board.id, shareKeys: true })).status).toBe(403);
    expect((await repository().projectById(board.id))?.shareKeys).toBe(false);

    await actAs(alice.id, board.id);
    expect((await put({ projectId: board.id, shareKeys: true })).status).toBe(200);
    expect((await repository().projectById(board.id))?.shareKeys).toBe(true);
  });
});
