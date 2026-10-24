import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenSummary } from "./index";
import { MemoryRepository } from "@/lib/db/memory-repository";

vi.mock("server-only", () => ({}));
const repo = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));

const { createToken, verifyToken, listTokens, revokeToken } = await import("./index");

let n = 1;
const newUser = () => repo.upsertUser({ githubId: n++, login: `u${n}`, name: null, avatarUrl: null });

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("access tokens", () => {
  it("verifies a secret to its user and mode", async () => {
    const user = await newUser();
    const rw = await createToken(user.id, { name: "rw", readOnly: false });
    const ro = await createToken(user.id, { name: "ro", readOnly: true });
    expect(rw.secret).toMatch(/^fmc_/);
    expect(await verifyToken(rw.secret)).toEqual({ user: expect.objectContaining({ id: user.id }), readOnly: false });
    expect(await verifyToken(ro.secret)).toEqual({ user: expect.objectContaining({ id: user.id }), readOnly: true });
    expect((await repo.accessTokensForUser(user.id))[0]?.lastUsedAt).not.toBeNull();
  });

  it("rejects unknown secrets", async () => {
    expect(await verifyToken("fmc_nope")).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const user = await newUser();
    const t = await createToken(user.id, { name: "t", readOnly: true });
    expect(await revokeToken(user.id, t.id)).toBe(true);
    expect(await verifyToken(t.secret)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const user = await newUser();
    const t = await createToken(user.id, { name: "t", readOnly: true, expiresAt: new Date(Date.now() - 1000) });
    expect(await verifyToken(t.secret)).toBeNull();
  });

  it("lists only safe fields", async () => {
    const user = await newUser();
    const t = await createToken(user.id, { name: "t", readOnly: true });
    const [listed] = await listTokens(user.id) as [AccessTokenSummary];
    expect(Object.keys(listed).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "lastFour", "lastUsedAt", "name", "readOnly", "revokedAt"].sort(),
    );
    expect(listed.lastFour).toBe(t.secret.slice(-4));
    expect(JSON.stringify(listed)).not.toContain(t.secret);
  });

  it("ignores a revoke from another user", async () => {
    const a = await newUser();
    const b = await newUser();
    const t = await createToken(a.id, { name: "t", readOnly: true });
    expect(await revokeToken(b.id, t.id)).toBe(false);
    expect(await verifyToken(t.secret)).not.toBeNull();
    expect((await listTokens(a.id))[0]?.revokedAt).toBeNull();
  });
});
