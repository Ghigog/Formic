import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, kpisFor } = vi.hoisted(() => ({ activeProject: vi.fn(), kpisFor: vi.fn() }));

vi.mock("@/lib/kpi", () => ({ kpisFor }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { GET } = await import("./route");

beforeEach(() => {
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  kpisFor.mockReset().mockResolvedValue({ tiles: {}, timeInColumn: {}, throughput: [], cycleTime: [] });
});

describe("GET /api/kpi", () => {
  it("answers tiles, time in column, throughput and cycle time", async () => {
    const res = await GET(new Request("http://localhost/api/kpi"));
    expect(Object.keys(await res.json())).toEqual(["tiles", "timeInColumn", "throughput", "cycleTime"]);
    expect(kpisFor).toHaveBeenCalledWith("p1", "30d");
  });

  it("reads the window", async () => {
    await GET(new Request("http://localhost/api/kpi?window=all"));
    expect(kpisFor).toHaveBeenCalledWith("p1", "all");
  });

  it("answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/api/kpi"))).status).toBe(409);
  });
});
