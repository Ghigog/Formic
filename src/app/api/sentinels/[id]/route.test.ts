import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, sentinelsFor, summonSentinel } = vi.hoisted(() => ({
  activeProject: vi.fn(),
  sentinelsFor: vi.fn(),
  summonSentinel: vi.fn(),
}));

vi.mock("@/lib/sentinels/service", () => ({ sentinelsFor, summonSentinel }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const call = (body?: unknown) =>
  POST(new Request("http://localhost/api/sentinels/s1", { method: "POST", body: body ? JSON.stringify(body) : undefined }), {
    params: Promise.resolve({ id: "s1" }),
  });

beforeEach(() => {
  clearBuckets();
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  sentinelsFor.mockReset().mockResolvedValue({ s1: {} });
  summonSentinel.mockReset().mockResolvedValue({ ok: true });
});

describe("POST /api/sentinels/[id]", () => {
  it("summons an audit by default and answers 202", async () => {
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sentinels: { s1: {} } });
    expect(summonSentinel).toHaveBeenCalledWith("p1", "s1", "audit");
  });

  it("calibrates when asked", async () => {
    await call({ kind: "calibrate" });
    expect(summonSentinel).toHaveBeenCalledWith("p1", "s1", "calibrate");
  });

  it("answers the service's refusal", async () => {
    summonSentinel.mockResolvedValue({ ok: false, error: "Unknown sentinel.", status: 404 });
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown sentinel." });
  });

  it("answers 429 once the run bucket is exhausted", async () => {
    for (let i = 0; i < 60; i++) expect((await call()).status).toBe(202);
    const res = await call();
    expect(res.status).toBe(429);
    expect(summonSentinel).toHaveBeenCalledTimes(60);
  });

  it("answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await call()).status).toBe(409);
    expect(summonSentinel).not.toHaveBeenCalled();
  });
});
