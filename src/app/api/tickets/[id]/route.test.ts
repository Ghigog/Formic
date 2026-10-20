import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { repo, activeProject } = vi.hoisted(() => ({
  repo: {
    projectOfCard: vi.fn(),
    ticketDetail: vi.fn(),
    boardCards: vi.fn(),
    ticketEvents: vi.fn(),
    columnOverrides: vi.fn(),
    ticketRunMs: vi.fn(),
  },
  activeProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/board/project", () => ({ activeProject }));

const { GET } = await import("./route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (id = "t-1") => GET(new NextRequest(`http://localhost/api/tickets/${id}`), params(id));

const card = { id: "t-1", key: "T-1", title: "Ticket", status: "todo", dependsOn: [], workingSince: null };

beforeEach(() => {
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1", ownerId: null });
  repo.projectOfCard.mockResolvedValue("p-1");
  repo.ticketDetail.mockResolvedValue({
    description: "Do it",
    acceptanceCriteria: ["works"],
    branchName: "t-1",
    epicId: null,
    plan: null,
    handoff: null,
    runnerJob: null,
  });
  repo.boardCards.mockResolvedValue([card]);
  repo.ticketEvents.mockResolvedValue([]);
  repo.columnOverrides.mockResolvedValue({});
  repo.ticketRunMs.mockResolvedValue(120_000);
});

describe("GET /api/tickets/[id]", () => {
  it("returns the ticket's view", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view).toMatchObject({
      card: { id: "t-1" },
      epic: null,
      description: "Do it",
      acceptanceCriteria: ["works"],
      branchName: "t-1",
      activity: [],
      canStop: false,
    });
    expect(view.usage.usedMinutes).toBe(2);
  });

  it("404s for an unknown ticket", async () => {
    repo.projectOfCard.mockResolvedValue(null);
    expect((await call("nope")).status).toBe(404);
  });

  it("404s when the ticket has no detail", async () => {
    repo.ticketDetail.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
