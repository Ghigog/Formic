import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { createTodoItem, activeProject } = vi.hoisted(() => ({
  createTodoItem: vi.fn(),
  activeProject: vi.fn(),
}));

vi.mock("@/lib/board/service", () => ({ createTodoItem }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tickets", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/tickets", () => {
  it("rejects a request that is too short to be a ticket", async () => {
    const res = await POST(request({ rawRequest: "hi" }));
    expect(res.status).toBe(400);
    expect(createTodoItem).not.toHaveBeenCalled();
  });

  it("rejects a request over the length limit", async () => {
    const res = await POST(request({ rawRequest: "x".repeat(4001) }));
    expect(res.status).toBe(400);
  });

  it("rejects a body with no rawRequest at all", async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(400);
  });

  it("fails the way an unpicked repository does when no project is active", async () => {
    activeProject.mockResolvedValue(null);

    const res = await POST(request({ rawRequest: "Fix the broken footer link." }));

    expect(res.status).toBe(409);
    expect(createTodoItem).not.toHaveBeenCalled();
  });

  it("creates the ticket and returns it with a 201", async () => {
    activeProject.mockResolvedValue({ id: "project_default" });
    const card = { id: "ticket-1", kind: "ticket" };
    createTodoItem.mockResolvedValue(card);

    const res = await POST(
      request({ rawRequest: "Fix the broken footer link.", requestId: "req-1" }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ card });
    expect(createTodoItem).toHaveBeenCalledWith(
      "project_default",
      "Fix the broken footer link.",
      "req-1",
    );
  });
});
