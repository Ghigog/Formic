import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { UserRecord } from "@/lib/db/repository";

vi.mock("server-only", () => ({}));
const tools = vi.hoisted(() => {
  const ok = () => vi.fn(async () => ({ ok: true as const, value: { done: true } }));
  return {
    listBoards: vi.fn(async () => [{ id: "b1" }]),
    listCards: ok(),
    getCard: ok(),
    getColony: ok(),
    createBacklogCard: ok(),
    createEpic: ok(),
    moveCard: ok(),
    updateCard: ok(),
    commentCard: ok(),
  };
});
vi.mock("./tools", () => tools);

const { mcpServerFor } = await import("./server");

const user = { id: "u1" } as UserRecord;

async function connect(readOnly = false) {
  const server = mcpServerFor(user, readOnly);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

beforeEach(() => vi.clearAllMocks());

describe("mcpServerFor", () => {
  it("registers every board tool, the reads marked read-only", async () => {
    const { tools: listed } = await (await connect()).listTools();
    expect(listed.map((t) => t.name).sort()).toEqual(
      ["comment_card", "create_backlog_card", "create_epic", "get_card", "get_colony", "list_boards", "list_cards", "move_card", "update_card"],
    );
    const readOnly = listed.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["get_card", "get_colony", "list_boards", "list_cards"]);
  });

  it("answers a read tool with the value as JSON", async () => {
    const client = await connect();
    expect(textOf(await client.callTool({ name: "list_boards", arguments: {} }))).toBe('[{"id":"b1"}]');
    expect(tools.listBoards).toHaveBeenCalledWith(user);
    await client.callTool({ name: "list_cards", arguments: { board: "b", column: "done" } });
    expect(tools.listCards).toHaveBeenCalledWith(user, { board: "b", column: "done" });
    await client.callTool({ name: "get_card", arguments: { board: "b", card: "c" } });
    expect(tools.getCard).toHaveBeenCalledWith(user, { board: "b", card: "c" });
    const colony = await client.callTool({ name: "get_colony", arguments: { board: "b" } });
    expect(tools.getColony).toHaveBeenCalledWith(user, { board: "b" });
    expect(textOf(colony)).toBe('{"done":true}');
  });

  it("passes the caller and its read-only flag to write tools", async () => {
    const client = await connect(true);
    const caller = { user, readOnly: true };
    await client.callTool({ name: "create_backlog_card", arguments: { board: "b", rawRequest: "  add it  " } });
    expect(tools.createBacklogCard).toHaveBeenCalledWith(caller, { board: "b", rawRequest: "add it" });
    const epic = { board: "b", title: "E", rawRequest: "r", tickets: [{ key: "a", title: "A", description: "d", acceptanceCriteria: ["c"] }] };
    await client.callTool({ name: "create_epic", arguments: epic });
    expect(tools.createEpic).toHaveBeenCalledWith(caller, epic);
    await client.callTool({ name: "move_card", arguments: { board: "b", card: "c", to: "done" } });
    expect(tools.moveCard).toHaveBeenCalledWith(caller, { board: "b", card: "c", to: "done" });
    await client.callTool({ name: "comment_card", arguments: { board: "b", card: "c", text: "hi" } });
    expect(tools.commentCard).toHaveBeenCalledWith(caller, { board: "b", card: "c", text: "hi" });
  });

  it("splits update_card into the card and its edit", async () => {
    const client = await connect();
    await client.callTool({ name: "update_card", arguments: { board: "b", card: "c", title: "New", storyPoints: 3 } });
    expect(tools.updateCard).toHaveBeenCalledWith(
      { user, readOnly: false },
      { board: "b", card: "c", edit: { title: "New", storyPoints: 3 } },
    );
  });

  it("reports a refused tool as an error with its message", async () => {
    tools.moveCard.mockResolvedValueOnce({ ok: false as never, error: "Board says no." } as never);
    const result = await (await connect()).callTool({ name: "move_card", arguments: { board: "b", card: "c", to: "done" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Board says no.");
  });
});
