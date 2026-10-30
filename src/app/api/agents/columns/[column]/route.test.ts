import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));

const launch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/pipeline", () => ({ launch }));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, signSession } = await import("@/lib/auth/session");
const { PROJECT_COOKIE } = await import("@/lib/board/project");
const { resetEnvCache } = await import("@/lib/secrets/env");

const { PUT } = await import("./route");

function put(body: unknown): Request {
  return new Request("http://localhost/api/agents/columns/in_progress", { method: "PUT", body: JSON.stringify(body) });
}
const ctx = (column: string) => ({ params: Promise.resolve({ column }) });

let presetId: string;
let otherPresetId: string;

beforeEach(async () => {
  globalThis.__formicMemoryStore = undefined;
  launch.mockClear();
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

describe("PUT /api/agents/columns/[column]", () => {
  it("assigns the person's preset to the column", async () => {
    const res = await PUT(put({ presetId }), ctx("in_progress"));
    expect(res.status).toBe(200);
    expect((await res.json()).columns).toEqual({ in_progress: presetId });
  });

  it("starts runner setup and adds the AGENTS.md and DESIGN.md tickets on the board's first agent only", async () => {
    const projectId = jar.get(PROJECT_COOKIE)!;
    expect(await repository().boardCards(projectId)).toHaveLength(0);
    await PUT(put({ presetId }), ctx("in_progress"));
    expect(launch).toHaveBeenCalledTimes(1);
    const cards = await repository().boardCards(projectId);
    expect(cards.filter((c) => c.title.includes("AGENTS.md"))).toHaveLength(1);
    expect(cards.find((c) => c.title.includes("AGENTS.md"))!.status).toBe("ready");
    expect(cards.find((c) => c.title.includes("DESIGN.md"))).toMatchObject({ status: "blocked", stalledIn: "todo" });

    await PUT(put({ presetId }), ctx("review"));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(await repository().boardCards(projectId)).toHaveLength(2);
  });

  it("unassigns with a null presetId", async () => {
    await PUT(put({ presetId }), ctx("in_progress"));
    expect((await (await PUT(put({ presetId: null }), ctx("in_progress"))).json()).columns).toEqual({});
  });

  it("rejects an unknown column and a malformed body", async () => {
    expect((await PUT(put({ presetId }), ctx("nowhere"))).status).toBe(400);
    expect((await PUT(put({ presetId: "" }), ctx("in_progress"))).status).toBe(400);
    expect((await PUT(put({}), ctx("in_progress"))).status).toBe(400);
  });

  it("answers 404 for another person's preset", async () => {
    expect((await PUT(put({ presetId: otherPresetId }), ctx("in_progress"))).status).toBe(404);
  });

  it("asks to sign in when there is no session", async () => {
    jar.clear();
    expect((await PUT(put({ presetId }), ctx("in_progress"))).status).toBe(401);
  });

  it("answers 409 to someone with no board", async () => {
    const other = await repository().upsertUser({ githubId: 3, login: "c", name: null, avatarUrl: null });
    jar.set(SESSION_COOKIE, await signSession(other.id));
    expect((await PUT(put({ presetId: null }), ctx("in_progress"))).status).toBe(409);
  });
});
