import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/lib/db/memory-repository";

vi.mock("server-only", () => ({}));
const repo = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));

const { POST } = await import("./route");
const { createPmToken, createToken, revokePmTokens, revokeToken } = await import("@/lib/access-tokens");
const { PM_TOOLS } = await import("@/lib/mcp/server");

const call = (method: string, token?: string, params?: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? (method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } : {}) }),
    }),
  );

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("/api/mcp", () => {
  it("refuses a missing, unknown, revoked or expired token with 401", async () => {
    const user = await repo.upsertUser({ githubId: 1, login: "a", name: null, avatarUrl: null });
    const revoked = await createToken(user.id, { name: "r", readOnly: true });
    await revokeToken(user.id, revoked.id);
    const expired = await createToken(user.id, { name: "e", readOnly: true, expiresAt: new Date(Date.now() - 1000) });
    expect((await call("tools/list")).status).toBe(401);
    expect((await call("tools/list", "fmc_nope")).status).toBe(401);
    expect((await call("tools/list", revoked.secret)).status).toBe(401);
    expect((await call("tools/list", expired.secret)).status).toBe(401);
  });

  it("lists the read and write tools for a valid token", async () => {
    const user = await repo.upsertUser({ githubId: 2, login: "b", name: null, avatarUrl: null });
    const { secret } = await createToken(user.id, { name: "ro", readOnly: true });
    const res = await call("tools/list", secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "comment_card",
      "create_backlog_card",
      "create_epic",
      "get_card",
      "get_colony",
      "list_boards",
      "list_cards",
      "move_card",
      "update_card",
    ]);
  });

  it("gives a PM token only the PM's tools, on its own board only, until its session ends", async () => {
    const user = await repo.upsertUser({ githubId: 3, login: "c", name: null, avatarUrl: null });
    const own = await repo.ensureProject({ ownerId: user.id, repoFullName: null, name: "own", baseBranch: "main" });
    const other = await repo.ensureProject({ ownerId: user.id, repoFullName: null, name: "other", baseBranch: "main" });
    const { secret } = await createPmToken(user.id, { projectId: own.id, sessionId: "s1" });

    const listed = await (await call("tools/list", secret)).json();
    expect(listed.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([...PM_TOOLS].sort());

    const boards = await (await call("tools/call", secret, { name: "list_boards", arguments: {} })).json();
    expect(JSON.parse(boards.result.content[0].text)).toEqual([expect.objectContaining({ id: own.id })]);

    const elsewhere = await (await call("tools/call", secret, { name: "list_cards", arguments: { board: other.id } })).json();
    expect(elsewhere.result.isError).toBe(true);
    expect(elsewhere.result.content[0].text).toBe("This token works only on its own board.");
    const here = await (await call("tools/call", secret, { name: "list_cards", arguments: { board: own.id } })).json();
    expect(here.result.isError).toBeFalsy();

    await revokePmTokens(own.id, "s1");
    expect((await call("tools/list", secret)).status).toBe(401);
  });
});
