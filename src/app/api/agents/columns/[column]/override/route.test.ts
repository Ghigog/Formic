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
  return new Request("http://localhost/api/agents/columns/in_progress/override", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
const ctx = (column: string) => ({ params: Promise.resolve({ column }) });

let projectId: string;

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
  projectId = project.id;
  const preset = await repo.savePreset({
    ownerId: user.id,
    provider: "anthropic",
    name: "Coder",
    model: "claude-opus-5",
    prompt: "p",
  });
  await repo.setColumnAgent(project.id, "in_progress", preset.id);
});

describe("PUT /api/agents/columns/[column]/override", () => {
  it("stores the override and answers with the board's overrides", async () => {
    const res = await PUT(put({ minutes: 20, tokens: 1000 }), ctx("in_progress"));
    expect(res.status).toBe(200);
    const expected = { in_progress: { minutes: 20, tokens: 1000, attempts: null } };
    expect((await res.json()).overrides).toEqual(expected);
    expect(await repository().columnOverrides(projectId)).toEqual(expected);
  });

  it.each([
    ["a cents field", { tokens: 1, maxCents: 5 }],
    ["zero", { attempts: 0 }],
    ["a fraction", { minutes: 1.5 }],
  ])("rejects %s", async (_name, body) => {
    expect((await PUT(put(body), ctx("in_progress"))).status).toBe(400);
  });

  it("rejects an unknown column", async () => {
    expect((await PUT(put({ attempts: 1 }), ctx("nowhere"))).status).toBe(400);
  });

  it("answers 404 for a column with no agent", async () => {
    expect((await PUT(put({ attempts: 1 }), ctx("in_review"))).status).toBe(404);
  });

  it("answers 409 to someone with no board", async () => {
    const other = await repository().upsertUser({ githubId: 2, login: "b", name: null, avatarUrl: null });
    jar.set(SESSION_COOKIE, await signSession(other.id));
    expect((await PUT(put({ attempts: 1 }), ctx("in_progress"))).status).toBe(409);
  });

  it("asks to sign in when there is no session", async () => {
    jar.clear();
    expect((await PUT(put({ attempts: 1 }), ctx("in_progress"))).status).toBe(401);
  });
});
