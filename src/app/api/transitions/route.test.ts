import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { cardById, activeProject, applyTransition } = vi.hoisted(() => ({
  cardById: vi.fn(),
  activeProject: vi.fn(),
  applyTransition: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ cardById }) }));
vi.mock("@/lib/board/service", () => ({ applyTransition }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

beforeEach(() => {
  clearBuckets();
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1" });
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/transitions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/transitions", () => {
  it("reverts a malformed move of a known card to its current column", async () => {
    cardById.mockResolvedValue({ id: "c-1", status: "ready" });
    const res = await POST(request({ cardId: "c-1", to: "nowhere" }));
    expect(res.status).toBe(400);
    expect((await res.json()).revertTo).toBe("todo");
    expect(applyTransition).not.toHaveBeenCalled();
  });

  it("omits revertTo when the card is not known", async () => {
    cardById.mockResolvedValue(null);
    const res = await POST(request({ cardId: "ghost" }));
    expect(res.status).toBe(400);
    expect("revertTo" in (await res.json())).toBe(false);
  });

  it("omits revertTo when the body has no cardId", async () => {
    const res = await POST(request("garbage"));
    expect(res.status).toBe(400);
    expect("revertTo" in (await res.json())).toBe(false);
  });
});
