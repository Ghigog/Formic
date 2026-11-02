import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/lib/db/memory-repository";

vi.mock("server-only", () => ({}));
const { currentUser } = vi.hoisted(() => ({ currentUser: vi.fn() }));
const repo = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));

const { createToken, verifyToken } = await import("@/lib/access-tokens");
const { DELETE } = await import("./route");

let n = 1;
const newUser = () => repo.upsertUser({ githubId: n++, login: `u${n}`, name: null, avatarUrl: null });
const del = (id: string) => DELETE(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("DELETE /api/access-tokens/[id]", () => {
  it("answers 401 when nobody is signed in", async () => {
    const owner = await newUser();
    const token = await createToken(owner.id, { name: "t", readOnly: false });
    currentUser.mockResolvedValue(null);
    expect((await del(token.id)).status).toBe(401);
    expect(await verifyToken(token.secret)).not.toBeNull();
  });

  it("answers 404 for someone else's token or an unknown one, leaving the token untouched", async () => {
    const owner = await newUser();
    const other = await newUser();
    const token = await createToken(owner.id, { name: "t", readOnly: false });
    currentUser.mockResolvedValue(other);
    expect((await del(token.id)).status).toBe(404);
    expect((await del("nope")).status).toBe(404);
    expect(await verifyToken(token.secret)).not.toBeNull();
  });

  it("answers 204 for the person's own token, which then stops working", async () => {
    const owner = await newUser();
    const token = await createToken(owner.id, { name: "t", readOnly: false });
    currentUser.mockResolvedValue(owner);
    expect((await del(token.id)).status).toBe(204);
    expect(await verifyToken(token.secret)).toBeNull();
  });
});
