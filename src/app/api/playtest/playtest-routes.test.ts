import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Playtest routes: who may do what, and what each hands to the service. */

const m = vi.hoisted(() => ({
  user: { id: "u1", name: "Ada", login: "ada" } as { id: string; name?: string; login: string } | null,
  project: { id: "p1", repoFullName: "a/b", baseBranch: "main" } as { id: string; repoFullName: string; baseBranch: string } | null,
  access: { ok: true, e2bKey: "k", repoToken: "t" } as Record<string, unknown>,
  head: "sha" as string | null,
  sessions: new Map<string, Record<string, unknown>>(),
  messages: [] as Array<Record<string, unknown>>,
  calls: [] as Array<[string, ...unknown[]]>,
}));

const now = new Date("2026-11-19T00:00:00Z");
const record = (over: Record<string, unknown> = {}) => ({
  id: "pt1",
  projectId: "p1",
  userId: "u1",
  status: "live",
  url: "https://8484-x.e2b.app",
  commitSha: "abc",
  stage: null,
  kind: "static",
  logTail: null,
  error: null,
  endReason: null,
  summary: null,
  nudgedSha: null,
  startedAt: now,
  endsAt: now,
  endedAt: null,
  ...over,
});

vi.mock("@/lib/auth/user", () => ({ currentUser: async () => m.user, asSignedIn: <T,>(h: T) => h }));
vi.mock("@/lib/board/project", () => ({ activeProject: async () => m.project, noProject: () => Response.json({}, { status: 409 }) }));
vi.mock("@/lib/rate-limit", () => ({ limited: () => null, RUN: "run" }));
vi.mock("@/lib/origin", () => ({ configuredOrigin: () => "https://formic.test" }));
vi.mock("@/lib/vcs", () => ({ vcs: () => ({ branchHead: async () => m.head }) }));
vi.mock("@/lib/playtest/access", () => ({ playtestAccess: async () => m.access }));
vi.mock("@/lib/db", () => ({
  repository: () => ({
    playtest: async (id: string) => m.sessions.get(id) ?? null,
    openPlaytestsFor: async () => [...m.sessions.values()].filter((s) => s.status === "live"),
    playtestMessages: async () => m.messages,
    playtestsFor: async () => [...m.sessions.values()],
    userById: async (id: string) => (id === "u1" ? { name: "Ada", login: "ada" } : null),
  }),
}));
vi.mock("@/lib/playtest/service", async (orig) => {
  const real = await orig<typeof import("@/lib/playtest/service")>();
  return {
    viewOf: real.viewOf,
    isOpen: real.isOpen,
    ensureReaper: () => {},
    startPlaytest: async (input: unknown) => (m.calls.push(["start", input]), record({ status: "starting", url: null })),
    stopPlaytest: async (id: string, why: string) => (m.calls.push(["stop", id, why]), record({ status: "ended", endReason: why })),
    tick: async (r: unknown) => (m.calls.push(["tick"]), r),
    addNote: async (_r: unknown, text: string, shots: string[]) => (
      m.calls.push(["note", text, shots]), { id: "n1", role: "user", content: text, status: "done", proposals: [], attachments: [], createdAt: now }
    ),
    askAboutNotes: async () => (m.calls.push(["ask"]), true),
  };
});

const root = await import("./route");
const one = await import("./[id]/route");
const notes = await import("./[id]/notes/route");
const ask = await import("./[id]/ask/route");
const sessions = await import("./sessions/route");

const params = (id = "pt1") => ({ params: Promise.resolve({ id }) });
const json = async (res: unknown) => {
  const r = res as Response;
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeEach(() => {
  m.user = { id: "u1", name: "Ada", login: "ada" };
  m.project = { id: "p1", repoFullName: "a/b", baseBranch: "main" };
  m.access = { ok: true, e2bKey: "k", repoToken: "t" };
  m.head = "sha";
  m.sessions = new Map([["pt1", record()]]);
  m.messages = [];
  m.calls = [];
});

describe("/api/playtest", () => {
  it("reports access without the key, and the open session", async () => {
    const { body } = await json(await root.GET());
    expect(body.access).toEqual({ ok: true });
    expect((body.session as { id: string }).id).toBe("pt1");
  });

  it("refuses to start for someone blocked, or whose access cannot read the branch", async () => {
    m.access = { ok: false, reason: "no-key", message: "Add your key." };
    expect(await json(await root.POST(new Request("http://x/api/playtest", { method: "POST" })))).toMatchObject({
      status: 403,
      body: { reason: "no-key" },
    });
    m.access = { ok: true, e2bKey: "k", repoToken: "t" };
    m.head = null;
    expect((await json(await root.POST(new Request("http://x/api/playtest", { method: "POST" })))).body.reason).toBe("no-repo-access");
    expect(m.calls).toEqual([]);
  });

  it("starts a session on the person's keys, for the configured origin", async () => {
    const { status } = await json(await root.POST(new Request("http://x/api/playtest", { method: "POST" })));
    expect(status).toBe(201);
    expect(m.calls[0]).toEqual(["start", expect.objectContaining({ userId: "u1", e2bKey: "k", repoToken: "t", formicOrigin: "https://formic.test" })]);
  });

  it("asks to sign in first", async () => {
    m.user = null;
    expect((await json(await root.GET())).status).toBe(401);
  });
});

describe("/api/playtest/[id]", () => {
  it("keeps the person's own session alive as it reads it, but only reads someone else's", async () => {
    const mine = await json(await one.GET(new Request("http://x"), params()));
    expect(mine.body.own).toBe(true);
    expect(m.calls).toEqual([["tick"]]);
    m.sessions.set("pt1", record({ userId: "u2" }));
    m.calls = [];
    expect((await json(await one.GET(new Request("http://x"), params()))).body.own).toBe(false);
    expect(m.calls).toEqual([]);
  });

  it("lets only its owner stop it, and hides another board's", async () => {
    m.sessions.set("pt1", record({ userId: "u2" }));
    expect((await json(await one.DELETE(new Request("http://x"), params()))).status).toBe(404);
    m.sessions.set("pt1", record());
    expect((await json(await one.DELETE(new Request("http://x"), params()))).status).toBe(200);
    expect(m.calls).toEqual([["stop", "pt1", "stopped"]]);
    m.sessions.set("pt1", record({ projectId: "other" }));
    expect((await json(await one.GET(new Request("http://x"), params()))).status).toBe(404);
  });
});

describe("notes and asking", () => {
  const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

  it("takes a note with its screenshots' request ids, and refuses an empty one", async () => {
    const ok = await json(await notes.POST(post({ text: "Jump is late", shots: ["playtest-1"] }), params()));
    expect(ok.status).toBe(201);
    expect(m.calls).toEqual([["note", "Jump is late", ["playtest-1"]]]);
    expect((await json(await notes.POST(post({ text: "  " }), params()))).status).toBe(400);
    expect((await json(await notes.POST(post({ text: "x", shots: ["other-1"] }), params()))).status).toBe(400);
  });

  it("asks the PM about the notes so far", async () => {
    expect((await json(await ask.POST(new Request("http://x", { method: "POST" }), params()))).body).toEqual({ asked: true });
  });
});

describe("/api/playtest/sessions", () => {
  it("lists the board's sessions with who ran them and how many notes", async () => {
    m.messages = [{ role: "user" }, { role: "assistant" }];
    const { body } = await json(await sessions.GET());
    expect(body.sessions).toEqual([expect.objectContaining({ id: "pt1", by: "Ada", mine: true, notes: 1 })]);
  });
});
