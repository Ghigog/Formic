import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { repo, activeProject, ask } = vi.hoisted(() => ({
  repo: {
    projectOfCard: vi.fn(),
    cardChatMessages: vi.fn(),
    clearCardChat: vi.fn(),
  },
  activeProject: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/board/project", () => ({ activeProject }));
// The card chat agent is stubbed: no model is called.
vi.mock("@/lib/agents/card-chat", () => ({
  ask,
  ChatBusyError: class ChatBusyError extends Error {},
}));

const { GET, POST, DELETE } = await import("./route");
const { ChatBusyError } = await import("@/lib/agents/card-chat");
const { clearBuckets } = await import("@/lib/rate-limit");

const params = { params: Promise.resolve({ id: "t-1" }) };
const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/tickets/t-1/chat", { method: "POST", body: JSON.stringify(body) }),
    params,
  );
const get = () => GET(new NextRequest("http://localhost/api/tickets/t-1/chat"), params);
const del = () => DELETE(new NextRequest("http://localhost/api/tickets/t-1/chat", { method: "DELETE" }), params);

beforeEach(() => {
  clearBuckets();
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.projectOfCard.mockResolvedValue("p-1");
  repo.cardChatMessages.mockResolvedValue([{ role: "user", text: "hi" }]);
});

describe("/api/tickets/[id]/chat", () => {
  it("GET returns the chat messages", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [{ role: "user", text: "hi" }] });
  });

  it("POST asks the column agent and returns the chat", async () => {
    const res = await post({ text: "  what next?  " });
    expect(res.status).toBe(200);
    expect(ask).toHaveBeenCalledWith("p-1", "ticket", "t-1", "what next?");
    expect(await res.json()).toEqual({ messages: [{ role: "user", text: "hi" }] });
  });

  it("POST 400s on an empty question", async () => {
    expect((await post({ text: "  " })).status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
  });

  it("POST 429s over the limit", async () => {
    for (let i = 0; i < 60; i++) expect((await post({ text: "hello" })).status).toBe(200);
    expect((await post({ text: "hello" })).status).toBe(429);
  });

  it("POST 409s while the agent is busy", async () => {
    ask.mockRejectedValue(new ChatBusyError());
    expect((await post({ text: "hello" })).status).toBe(409);
  });

  it("DELETE clears the chat", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(repo.clearCardChat).toHaveBeenCalledWith("t-1");
  });

  it("404s every method for an unknown ticket", async () => {
    repo.projectOfCard.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect((await post({ text: "hello" })).status).toBe(404);
    expect((await del()).status).toBe(404);
    expect(ask).not.toHaveBeenCalled();
    expect(repo.clearCardChat).not.toHaveBeenCalled();
  });
});
