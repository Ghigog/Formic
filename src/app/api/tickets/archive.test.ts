import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { repository, activeProject, createTodoItem } = vi.hoisted(() => ({
  repository: vi.fn(),
  activeProject: vi.fn(),
  createTodoItem: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));
vi.mock("@/lib/board/service", () => ({ createTodoItem }));

const { GET } = await import("./archived/route");
const { PATCH } = await import("./[id]/archive/route");

const project = { id: "project_default" };

function archiveRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/tickets/${id}/archive`, {
    method: "PATCH",
  });
}

describe("PATCH /api/tickets/{id}/archive", () => {
  it("archives the ticket and it leaves the active board list", async () => {
    const projectOfCard = vi.fn().mockResolvedValue(project.id);
    const ticketDetail = vi.fn().mockResolvedValue({ id: "ticket-1" });
    const updateTicket = vi.fn().mockResolvedValue(undefined);
    repository.mockReturnValue({ projectOfCard, ticketDetail, updateTicket });
    activeProject.mockResolvedValue(project);

    const res = await PATCH(archiveRequest("ticket-1"), {
      params: Promise.resolve({ id: "ticket-1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: true });
    expect(updateTicket).toHaveBeenCalledWith("ticket-1", { archived: true });
  });

  it("succeeds again on a ticket that is already archived, without changing anything", async () => {
    const projectOfCard = vi.fn().mockResolvedValue(project.id);
    const ticketDetail = vi.fn().mockResolvedValue({ id: "ticket-1" });
    const updateTicket = vi.fn().mockResolvedValue(undefined);
    repository.mockReturnValue({ projectOfCard, ticketDetail, updateTicket });
    activeProject.mockResolvedValue(project);

    const res = await PATCH(archiveRequest("ticket-1"), {
      params: Promise.resolve({ id: "ticket-1" }),
    });
    // The second call is the same write, so it stays archived.
    const again = await PATCH(archiveRequest("ticket-1"), {
      params: Promise.resolve({ id: "ticket-1" }),
    });

    expect(res.status).toBe(200);
    expect(again.status).toBe(200);
    expect(updateTicket).toHaveBeenCalledTimes(2);
    expect(updateTicket).toHaveBeenLastCalledWith("ticket-1", { archived: true });
  });

  it("404s for a ticket of another project, or one that is not a ticket", async () => {
    activeProject.mockResolvedValue(project);

    repository.mockReturnValue({
      projectOfCard: vi.fn().mockResolvedValue("project_other"),
      ticketDetail: vi.fn(),
      updateTicket: vi.fn(),
    });
    const other = await PATCH(archiveRequest("ticket-1"), {
      params: Promise.resolve({ id: "ticket-1" }),
    });
    expect(other.status).toBe(404);

    repository.mockReturnValue({
      projectOfCard: vi.fn().mockResolvedValue(project.id),
      ticketDetail: vi.fn().mockResolvedValue(null),
      updateTicket: vi.fn(),
    });
    const epic = await PATCH(archiveRequest("epic-1"), {
      params: Promise.resolve({ id: "epic-1" }),
    });
    expect(epic.status).toBe(404);
  });

  it("404s when no project is active", async () => {
    activeProject.mockResolvedValue(null);
    repository.mockReturnValue({
      projectOfCard: vi.fn(),
      ticketDetail: vi.fn(),
      updateTicket: vi.fn(),
    });

    const res = await PATCH(archiveRequest("ticket-1"), {
      params: Promise.resolve({ id: "ticket-1" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/tickets/archived", () => {
  it("returns only the project's archived tickets", async () => {
    const archivedTickets = vi
      .fn()
      .mockResolvedValue([{ id: "ticket-1", kind: "ticket", archived: true }]);
    repository.mockReturnValue({ archivedTickets });
    activeProject.mockResolvedValue(project);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tickets: [{ id: "ticket-1", kind: "ticket", archived: true }],
    });
    expect(archivedTickets).toHaveBeenCalledWith(project.id);
  });

  it("returns an empty list when no project is active", async () => {
    const archivedTickets = vi.fn();
    repository.mockReturnValue({ archivedTickets });
    activeProject.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tickets: [] });
    expect(archivedTickets).not.toHaveBeenCalled();
  });
});
