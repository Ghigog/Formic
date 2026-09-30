import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { createBacklogItem, activeProject } = vi.hoisted(() => ({
  createBacklogItem: vi.fn(),
  activeProject: vi.fn(),
}));

vi.mock("@/lib/board/service", () => ({ createBacklogItem }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

beforeEach(() => {
  clearBuckets();
  createBacklogItem.mockReset();
  activeProject.mockResolvedValue({ id: "project_default" });
  createBacklogItem.mockResolvedValue({ id: "epic-1", kind: "epic" });
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/epics", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/epics", () => {
  it("creates a plain epic with no work type", async () => {
    const res = await POST(request({ rawRequest: "Fix the error page" }));
    expect(res.status).toBe(201);
    expect(createBacklogItem).toHaveBeenCalledWith("project_default", "Fix the error page", undefined);
  });

  it.each(["bug", "spike"])("passes workType %s on", async (workType) => {
    const res = await POST(request({ rawRequest: "Look into it", workType }));
    expect(res.status).toBe(201);
    expect(createBacklogItem).toHaveBeenCalledWith("project_default", "Look into it", workType);
  });

  it("rejects any other workType and creates nothing", async () => {
    const res = await POST(request({ rawRequest: "Look into it", workType: "epic-thing" }));
    expect(res.status).toBe(400);
    expect(createBacklogItem).not.toHaveBeenCalled();
  });
});
