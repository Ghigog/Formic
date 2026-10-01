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
const { GET } = await import("./route");
const { POST } = await import("./token-window/route");
const { PUT: putOverride } = await import("./columns/[column]/override/route");
const { PUT: putAllowance } = await import("./presets/[id]/allowance/route");

function put(body: unknown): Request {
  return new Request("http://localhost/api/agents", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const column = (c: string) => ({ params: Promise.resolve({ column: c }) });
const presetParams = (id: string) => ({ params: Promise.resolve({ id }) });

let userId: string;
let presetId: string;

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
  userId = user.id;
  jar.set(SESSION_COOKIE, await signSession(user.id));
  const project = await repo.ensureProject({ ownerId: user.id, repoFullName: "a/board", baseBranch: "main" });
  jar.set(PROJECT_COOKIE, project.id);
  const preset = await repo.savePreset({
    ownerId: user.id,
    provider: "anthropic",
    name: "Coder",
    model: "claude-opus-5",
    prompt: "p",
  });
  presetId = preset.id;
  await repo.setColumnAgent(project.id, "in_progress", presetId);
});

describe("/api/agents token window", () => {
  it("reads all time with nothing set", async () => {
    expect((await (await GET()).json()).window).toEqual({ kind: "all-time", since: null, timezone: null });
  });

  it("reads the renewal window in the stored timezone", async () => {
    await repository().updateTokenRenewal(userId, { tokenRenewalDay: 5, tokenWindowTimezone: "UTC" });
    const { window } = await (await GET()).json();
    expect(window.kind).toBe("renewal");
    expect(window.timezone).toBe("UTC");
    expect(new Date(window.since).getUTCDate()).toBe(5);
  });

  it("stamps a reset for the current user, which the next read reports", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const { window } = await (await GET()).json();
    expect(window.kind).toBe("reset");
    expect(window.since).toBe((await res.json()).resetAt);
  });

  it("refuses a reset when nobody is signed in", async () => {
    jar.clear();
    expect((await POST()).status).toBe(401);
  });
});

describe("/api/agents column override", () => {
  it("returns the override with the board's agents", async () => {
    const res = await putOverride(put({ minutes: 20, tokens: 150000, attempts: 3 }), column("in_progress"));
    expect(res.status).toBe(200);
    const body = await (await GET()).json();
    expect(body.columns).toEqual({ in_progress: presetId });
    expect(body.overrides).toEqual({ in_progress: { minutes: 20, tokens: 150000, attempts: 3 } });
  });

  it("stores an override for one axis and leaves the others on the person's setting", async () => {
    await putOverride(put({ tokens: 90000 }), column("in_progress"));
    expect((await (await GET()).json()).overrides.in_progress).toEqual({ minutes: null, tokens: 90000, attempts: null });
  });

  it("refuses an override on a column with no agent", async () => {
    expect((await putOverride(put({ attempts: 2 }), column("in_review"))).status).toBe(404);
  });

  it.each([
    ["a cents field", { tokens: 1000, maxCents: 500 }],
    ["zero", { attempts: 0 }],
    ["a fraction", { minutes: 1.5 }],
  ])("rejects %s and stores nothing", async (_name, body) => {
    expect((await putOverride(put(body), column("in_progress"))).status).toBe(400);
    expect((await (await GET()).json()).overrides).toEqual({});
  });
});

describe("/api/agents token allowance", () => {
  it("defaults the window to a rolling 30 days", async () => {
    const res = await putAllowance(put({ tokens: 2_000_000 }), presetParams(presetId));
    expect(await res.json()).toEqual({ tokens: 2_000_000, windowDays: 30 });
    const preset = (await (await GET()).json()).presets[0];
    expect(preset).toMatchObject({ tokenAllowance: 2_000_000, tokenAllowanceWindowDays: 30 });
  });

  it("stores a chosen window, and clears the allowance with null tokens", async () => {
    expect(await (await putAllowance(put({ tokens: 500, windowDays: 7 }), presetParams(presetId))).json()).toEqual({
      tokens: 500,
      windowDays: 7,
    });
    expect((await (await putAllowance(put({ tokens: null }), presetParams(presetId))).json()).tokens).toBeNull();
  });

  it.each([
    ["a cents field", { tokens: 100, cents: 5 }],
    ["a window of zero days", { tokens: 100, windowDays: 0 }],
    ["tokens as text", { tokens: "lots" }],
  ])("rejects %s", async (_name, body) => {
    expect((await putAllowance(put(body), presetParams(presetId))).status).toBe(400);
  });
});

