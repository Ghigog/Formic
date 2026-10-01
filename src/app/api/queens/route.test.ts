import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeCard } from "@/test/cards";

const { repo, activeProject, publish } = vi.hoisted(() => ({
  repo: {
    boardCards: vi.fn(),
    listQueens: vi.fn(),
    queensSpent: vi.fn(),
    placeQueen: vi.fn(),
  },
  activeProject: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));
vi.mock("@/lib/events/bus", () => ({ publish }));

const { POST } = await import("./route");

function post(cardId: string) {
  return POST(new NextRequest("http://localhost/api/queens", { method: "POST", body: JSON.stringify({ cardId }) }));
}

/** A board at level 2 (50 XP): one Queen earned. */
function board(...extra: ReturnType<typeof makeCard>[]) {
  return [makeCard({ id: "m", status: "merged", storyPoints: 5, mergePoints: 50 }), ...extra];
}

beforeEach(() => {
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.listQueens.mockResolvedValue([]);
  repo.queensSpent.mockResolvedValue(0);
  repo.placeQueen.mockImplementation(async (projectId, cardId, kind) => ({ projectId, cardId, kind, placedAt: new Date() }));
  repo.boardCards.mockResolvedValue(board(makeCard({ id: "t-1" })));
});

describe("POST /api/queens", () => {
  it("places the Queen on a ticket and leaves none unspent", async () => {
    const res = await post("t-1");
    expect(res.status).toBe(201);
    expect((await res.json()).unspent).toBe(0);
    expect(repo.placeQueen).toHaveBeenCalledWith("p-1", "t-1", "ticket");
    expect(publish).toHaveBeenCalledWith("p-1", { type: "card.queen", cardId: "t-1", kind: "ticket" });
  });

  it("rejects it, storing nothing, when none is unspent", async () => {
    repo.boardCards.mockResolvedValue([makeCard({ id: "t-1" })]);
    expect((await post("t-1")).status).toBe(409);
    expect(repo.placeQueen).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not refund a Queen that was cleared", async () => {
    repo.queensSpent.mockResolvedValue(1);
    expect((await post("t-1")).status).toBe(409);
    expect(repo.placeQueen).not.toHaveBeenCalled();
  });

  it("rejects a card that already has a Queen", async () => {
    repo.boardCards.mockResolvedValue(board(makeCard({ id: "t-1", queen: true })));
    expect((await post("t-1")).status).toBe(409);
    expect(repo.placeQueen).not.toHaveBeenCalled();
  });

  it("rejects a Backlog draft with no tickets", async () => {
    repo.boardCards.mockResolvedValue(board(makeCard({ id: "e-1", kind: "epic", status: "draft", childCount: 0 })));
    expect((await post("e-1")).status).toBe(422);
    expect(repo.placeQueen).not.toHaveBeenCalled();
  });

  it("places a Queen on an Epic that has tickets", async () => {
    repo.boardCards.mockResolvedValue(board(makeCard({ id: "e-1", kind: "epic", childCount: 2 })));
    expect((await post("e-1")).status).toBe(201);
    expect(repo.placeQueen).toHaveBeenCalledWith("p-1", "e-1", "epic");
  });

  it("answers 404 for a card of another project", async () => {
    expect((await post("elsewhere")).status).toBe(404);
    expect(repo.placeQueen).not.toHaveBeenCalled();
  });
});
