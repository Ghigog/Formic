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
const { GET } = await import("./route");
const { MockVcsClient, resetVcs, setVcs } = await import("@/lib/vcs");
const { NextRequest } = await import("next/server");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new NextRequest(`http://localhost/api/tickets/${id}/findings`), ctx(id));

const client = new MockVcsClient("a/board");
let projectId: string;
let ticketId: string;
let epicId: string;

beforeEach(async () => {
  MockVcsClient.reset();
  resetVcs();
  vi.stubEnv("GITHUB_TOKEN", "test");
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
  setVcs(client);
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
});

describe("GET /api/tickets/[id]/findings", () => {
  it("returns a spike's findings file in full", async () => {
    await repository().updateTicket(ticketId, { workType: "spike" });
    const key = (await repository().ticketDetail(ticketId))!.key.toLowerCase();
    await client.commitFile("main", `docs/spikes/${key}-capture-bugs.md`, "# Findings", "m");

    const res = await get(ticketId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: true, path: `docs/spikes/${key}-capture-bugs.md`, markdown: "# Findings" });
  });

  it("returns found false with the PR url when the file is not on the branch", async () => {
    await repository().updateTicket(ticketId, { workType: "spike", prUrl: "https://github.com/a/board/pull/3" });

    expect(await (await get(ticketId)).json()).toEqual({ found: false, prUrl: "https://github.com/a/board/pull/3" });
  });

  it("answers 409 for a ticket that is not a spike, reading nothing", async () => {
    const list = vi.spyOn(client, "listFiles");
    const read = vi.spyOn(client, "readFile");

    expect((await get(ticketId)).status).toBe(409);
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown ticket and another user's board", async () => {
    expect((await get("nope")).status).toBe(404);
    const other = await repository().upsertUser({ githubId: 3, login: "c", name: null, avatarUrl: null });
    jar.set(SESSION_COOKIE, await signSession(other.id));
    expect((await get(ticketId)).status).toBe(404);
  });
});
