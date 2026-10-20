import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, sentinelsFor } = vi.hoisted(() => ({ activeProject: vi.fn(), sentinelsFor: vi.fn() }));

vi.mock("@/lib/sentinels/service", () => ({ sentinelsFor }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { GET } = await import("./route");

beforeEach(() => {
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  sentinelsFor.mockReset().mockResolvedValue({ a: { stars: 4 } });
});

describe("GET /api/sentinels", () => {
  it("answers every sentinel's report", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sentinels: { a: { stars: 4 } } });
    expect(sentinelsFor).toHaveBeenCalledWith("p1");
  });

  it("answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await GET()).status).toBe(409);
  });
});
