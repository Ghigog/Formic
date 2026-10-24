import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/lib/db/memory-repository";

vi.mock("server-only", () => ({}));
const repo = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));

const { POST } = await import("./route");
const { createToken, revokeToken } = await import("@/lib/access-tokens");

const call = (method: string, token?: string) =>
  POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } : {} }),
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

  it("lists the read tools for a valid token", async () => {
    const user = await repo.upsertUser({ githubId: 2, login: "b", name: null, avatarUrl: null });
    const { secret } = await createToken(user.id, { name: "ro", readOnly: true });
    const res = await call("tools/list", secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["get_card", "get_colony", "list_boards", "list_cards"]);
  });
});
