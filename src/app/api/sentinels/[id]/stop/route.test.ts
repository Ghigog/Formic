import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const { activeProject, sentinelsFor, stopSentinel } = vi.hoisted(() => ({
  activeProject: vi.fn(),
  sentinelsFor: vi.fn(),
  stopSentinel: vi.fn(),
}));

vi.mock("@/lib/sentinels/service", () => ({ sentinelsFor, stopSentinel }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const call = () =>
  POST(new Request("http://localhost/api/sentinels/s1/stop", { method: "POST" }), { params: Promise.resolve({ id: "s1" }) });

beforeEach(() => {
  clearBuckets();
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  sentinelsFor.mockReset().mockResolvedValue({ s1: {} });
  stopSentinel.mockReset().mockResolvedValue(true);
});

describe("POST /api/sentinels/[id]/stop", () => {
  it("stops the run and answers the new states", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sentinels: { s1: {} } });
    expect(stopSentinel).toHaveBeenCalledWith("p1", "s1");
  });

  it("answers 409 when nothing is running", async () => {
    stopSentinel.mockResolvedValue(false);
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Nothing is running." });
  });

  it("answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await call()).status).toBe(409);
    expect(stopSentinel).not.toHaveBeenCalled();
  });

  it("answers 429 once the run bucket is exhausted", async () => {
    // The limiter counts in clock-minute windows: pin the clock mid-minute so the calls cannot straddle one.
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    for (let i = 0; i < 60; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });
});
