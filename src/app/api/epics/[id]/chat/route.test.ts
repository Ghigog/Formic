import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  ask: vi.fn(),
  activeProject: vi.fn(),
  projectOfCard: vi.fn(),
  cardChatMessages: vi.fn(),
  clearCardChat: vi.fn(),
}));

class ChatBusyError extends Error {}

vi.mock("@/lib/agents/card-chat", () => ({ ask: m.ask, ChatBusyError }));
vi.mock("@/lib/board/project", () => ({ activeProject: m.activeProject }));
vi.mock("@/lib/db", () => ({
  repository: () => ({
    projectOfCard: m.projectOfCard,
    cardChatMessages: m.cardChatMessages,
    clearCardChat: m.clearCardChat,
  }),
}));

const { GET, POST, DELETE } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const ctx = { params: Promise.resolve({ id: "e-1" }) };
const messages = [{ role: "user", text: "hi" }];

beforeEach(() => {
  clearBuckets();
  Object.values(m).forEach((f) => f.mockReset());
  m.activeProject.mockResolvedValue({ id: "project_default" });
  m.projectOfCard.mockResolvedValue("project_default");
  m.cardChatMessages.mockResolvedValue(messages);
});

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/epics/e-1/chat", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("/api/epics/[id]/chat", () => {
  it("GET returns the chat messages", async () => {
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages });
  });

  it("answers 404 for an Epic outside the active project", async () => {
    m.projectOfCard.mockResolvedValue("someone-else");
    expect((await GET(req("GET"), ctx)).status).toBe(404);
    expect((await POST(req("POST", { text: "x" }), ctx)).status).toBe(404);
    expect((await DELETE(req("DELETE"), ctx)).status).toBe(404);
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("POST asks the stubbed agent and returns the chat", async () => {
    const res = await POST(req("POST", { text: " hello " }), ctx);
    expect(res.status).toBe(200);
    expect(m.ask).toHaveBeenCalledWith("project_default", "epic", "e-1", "hello");
    expect(await res.json()).toEqual({ messages });
  });

  it("POST answers 400 for an empty or missing text", async () => {
    expect((await POST(req("POST", { text: "   " }), ctx)).status).toBe(400);
    expect((await POST(req("POST", {}), ctx)).status).toBe(400);
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("POST answers 409 while the agent is busy", async () => {
    m.ask.mockRejectedValue(new ChatBusyError("Busy."));
    const res = await POST(req("POST", { text: "x" }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Busy." });
  });

  it("DELETE clears the chat", async () => {
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(m.clearCardChat).toHaveBeenCalledWith("e-1");
  });
});
