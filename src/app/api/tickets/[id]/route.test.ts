import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeCard } from "@/test/cards";

const { repo, activeProject } = vi.hoisted(() => ({
  repo: {
    projectOfCard: vi.fn(),
    boardCards: vi.fn(),
    updateTicket: vi.fn(),
  },
  activeProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/board/project", () => ({ activeProject }));

const { PATCH } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const params = { params: Promise.resolve({ id: "t-1" }) };

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/tickets/t-1", { method: "PATCH", body: JSON.stringify(body) }),
    params,
  );
}

beforeEach(() => {
  clearBuckets();
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.projectOfCard.mockResolvedValue("p-1");
  repo.boardCards.mockResolvedValue([makeCard({ id: "t-1", status: "ready" })]);
});

describe("PATCH /api/tickets/[id]", () => {
  it("sets the work type", async () => {
    expect((await patch({ workType: "bug" })).status).toBe(200);
    expect(repo.updateTicket).toHaveBeenCalledWith("t-1", { workType: "bug" });
  });

  it("clears the work type with null", async () => {
    expect((await patch({ workType: null })).status).toBe(200);
    expect(repo.updateTicket).toHaveBeenCalledWith("t-1", { workType: null });
  });

  it("answers 409 and changes nothing once the ticket has left To Do", async () => {
    repo.boardCards.mockResolvedValue([makeCard({ id: "t-1", status: "running" })]);
    expect((await patch({ workType: "spike" })).status).toBe(409);
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a work type", async () => {
    expect((await patch({ workType: "chore" })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });

  it("answers 404 for a ticket of another project", async () => {
    repo.projectOfCard.mockResolvedValue("p-2");
    expect((await patch({ workType: "bug" })).status).toBe(404);
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });
});
