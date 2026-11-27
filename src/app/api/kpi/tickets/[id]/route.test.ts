import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, ticketKpisFor } = vi.hoisted(() => ({ activeProject: vi.fn(), ticketKpisFor: vi.fn() }));

vi.mock("@/lib/kpi", () => ({ ticketKpisFor }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { GET } = await import("./route");
const call = () => GET(new Request("http://localhost/api/kpi/tickets/t1"), { params: Promise.resolve({ id: "t1" }) });

beforeEach(() => {
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  ticketKpisFor.mockReset().mockResolvedValue({ id: "t1", entries: [], passRate: 1, changesAfterSpec: 0 });
});

describe("GET /api/kpi/tickets/[id]", () => {
  it("answers entries, pass rate and changes after spec", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).changesAfterSpec).toBe(0);
    expect(ticketKpisFor).toHaveBeenCalledWith("p1", "t1");
  });

  it("answers 404 for a ticket outside the project", async () => {
    ticketKpisFor.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await call()).status).toBe(409);
  });
});
