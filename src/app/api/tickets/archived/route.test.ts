import { beforeEach, describe, expect, it, vi } from "vitest";

const { archivedTickets, archivedEpics, activeProject } = vi.hoisted(() => ({
  archivedTickets: vi.fn(),
  archivedEpics: vi.fn(),
  activeProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ archivedTickets, archivedEpics }) }));
vi.mock("@/lib/board/project", () => ({ activeProject }));

const { GET } = await import("./route");

beforeEach(() => vi.clearAllMocks());

describe("GET /api/tickets/archived", () => {
  it("lists the active project's archived tickets and Epics", async () => {
    activeProject.mockResolvedValue({ id: "p-1" });
    archivedTickets.mockResolvedValue([{ id: "t-1" }]);
    archivedEpics.mockResolvedValue([{ id: "e-1" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tickets: [{ id: "t-1" }], epics: [{ id: "e-1" }] });
    expect(archivedTickets).toHaveBeenCalledWith("p-1");
  });

  it("lists nothing without an active project", async () => {
    activeProject.mockResolvedValue(null);
    expect(await (await GET()).json()).toEqual({ tickets: [], epics: [] });
    expect(archivedTickets).not.toHaveBeenCalled();
    expect(archivedEpics).not.toHaveBeenCalled();
  });
});
