import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { repo, activeProject } = vi.hoisted(() => ({
  repo: {
    projectOfCard: vi.fn(),
    ticketDetail: vi.fn(),
    cardById: vi.fn(),
    updateTicket: vi.fn(),
  },
  activeProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/board/project", () => ({ activeProject }));

const { PATCH } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const params = { params: Promise.resolve({ id: "t-1" }) };
const call = () => PATCH(new NextRequest("http://localhost/api/tickets/t-1/archive", { method: "PATCH" }), params);

beforeEach(() => {
  clearBuckets();
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.projectOfCard.mockResolvedValue("p-1");
  repo.ticketDetail.mockResolvedValue({ id: "t-1", status: "stopped" });
  repo.cardById.mockResolvedValue({ id: "t-1" });
});

describe("PATCH /api/tickets/[id]/archive", () => {
  it("archives an existing ticket", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: true });
    expect(repo.updateTicket).toHaveBeenCalledWith("t-1", { archived: true });
  });

  it("404s for an unknown ticket", async () => {
    repo.projectOfCard.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });

  it("404s when the card is not a ticket", async () => {
    repo.ticketDetail.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });
});
