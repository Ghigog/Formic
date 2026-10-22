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

const { clearBuckets } = await import("@/lib/rate-limit");
const { POST } = await import("./route");
const { NextRequest } = await import("next/server");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/tickets/${id}/follow-ups`, { method: "POST", body: JSON.stringify(body) }), ctx(id));

let projectId: string;
let ticketId: string;
let epicId: string;

beforeEach(async () => {
  clearBuckets();
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
  const epic = await repo.createEpic({ projectId, title: "E", rawRequest: "E", position: 1 });
  epicId = epic.id;
  const [ticket] = await repo.createTickets([
    {
      epicId,
      key: `${epic.key}-T1`,
      title: "T",
      description: "d",
      acceptanceCriteria: [],
      fileScope: ["src/a"],
      size: "S",
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  ticketId = ticket!.id;
  await repo.updateTicket(ticketId, { followUps: [{ title: "Tidy up", why: "Left out", points: 2 }] });
});

describe("POST /api/tickets/[id]/follow-ups", () => {
  it("adds the follow-up as a ticket on the same Epic and removes it from the list", async () => {
    const res = await post(ticketId, { index: 0, add: true });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/^Added /);
    expect((await repository().ticketsForEpic(epicId)).map((t) => t.title)).toContain("Tidy up");
    expect((await repository().ticketDetail(ticketId))?.followUps).toEqual([]);
  });

  it("dismisses the follow-up without adding a ticket", async () => {
    const res = await post(ticketId, { index: 0, add: false });
    expect(await res.json()).toEqual({ message: "Dismissed." });
    expect(await repository().ticketsForEpic(epicId)).toHaveLength(1);
    expect((await repository().ticketDetail(ticketId))?.followUps).toEqual([]);
  });

  it("rejects a malformed body", async () => {
    expect((await post(ticketId, { index: -1, add: true })).status).toBe(400);
    expect((await post(ticketId, { index: 0 })).status).toBe(400);
  });

  it("answers 409 when the follow-up is no longer there", async () => {
    expect((await post(ticketId, { index: 5, add: true })).status).toBe(409);
  });

  it("answers 404 for an unknown ticket and without an active board", async () => {
    expect((await post("nope", { index: 0, add: true })).status).toBe(404);
    const other = await repository().upsertUser({ githubId: 3, login: "c", name: null, avatarUrl: null });
    jar.set(SESSION_COOKIE, await signSession(other.id));
    expect((await post(ticketId, { index: 0, add: true })).status).toBe(404);
  });
});
