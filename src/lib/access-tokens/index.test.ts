import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenSummary } from "./index";
import { MemoryRepository } from "@/lib/db/memory-repository";

vi.mock("server-only", () => ({}));
const repo = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));

const { createToken, createPmToken, revokePmTokens, verifyToken, listTokens, revokeToken, PM_TOKEN_MAX_HOURS } = await import("./index");

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
    expect(await verifyToken(rw.secret)).toEqual({ user: expect.objectContaining({ id: user.id }), readOnly: false, scope: null });
    expect(await verifyToken(ro.secret)).toEqual({ user: expect.objectContaining({ id: user.id }), readOnly: true, scope: null });
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

describe("PM tokens", () => {
  const board = async (ownerId: string) =>
    (await repo.ensureProject({ ownerId, repoFullName: null, name: `b${n++}`, baseBranch: "main" })).id;

  it("verifies to its board and session, never read-only", async () => {
    const user = await newUser();
    const projectId = await board(user.id);
    const { secret, expiresAt } = await createPmToken(user.id, { projectId, sessionId: "s1" });
    expect(await verifyToken(secret)).toEqual({
      user: expect.objectContaining({ id: user.id }),
      readOnly: false,
      scope: { projectId, sessionId: "s1" },
    });
    // Hours, not a standing key.
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(4 * 3_600_000);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(3 * 3_600_000);
  });

  it("never lives longer than the cap, whatever is asked", async () => {
    const user = await newUser();
    const { expiresAt } = await createPmToken(user.id, { projectId: await board(user.id), sessionId: "s" }, 24 * 365);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(PM_TOKEN_MAX_HOURS * 3_600_000);
  });

  it("stops working once it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const user = await newUser();
      const { secret } = await createPmToken(user.id, { projectId: await board(user.id), sessionId: "s" }, 1);
      vi.setSystemTime(Date.now() + 3_600_001);
      expect(await verifyToken(secret)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is revoked with its session and leaves other sessions and the person's own tokens alone", async () => {
    const user = await newUser();
    const projectId = await board(user.id);
    const ended = await createPmToken(user.id, { projectId, sessionId: "old" });
    const live = await createPmToken(user.id, { projectId, sessionId: "new" });
    const own = await createToken(user.id, { name: "mine", readOnly: false });
    expect(await revokePmTokens(projectId, "old")).toBe(1);
    expect(await verifyToken(ended.secret)).toBeNull();
    expect(await verifyToken(live.secret)).not.toBeNull();
    expect(await verifyToken(own.secret)).not.toBeNull();
  });

  it("is not listed among the person's tokens", async () => {
    const user = await newUser();
    await createPmToken(user.id, { projectId: await board(user.id), sessionId: "s" });
    await createToken(user.id, { name: "mine", readOnly: true });
    expect((await listTokens(user.id)).map((t) => t.name)).toEqual(["mine"]);
  });

  it("needs a real board and a session", async () => {
    const user = await newUser();
    await expect(createPmToken(user.id, { projectId: "nope", sessionId: "s" })).rejects.toThrow();
    await expect(createPmToken(user.id, { projectId: await board(user.id), sessionId: "" })).rejects.toThrow();
  });
});
