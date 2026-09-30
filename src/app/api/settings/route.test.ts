import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, signSession } = await import("@/lib/auth/session");
const { resetEnvCache } = await import("@/lib/secrets/env");
const { GET, PUT } = await import("./route");

function put(body: unknown): Request {
  return new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let userId: string;

beforeEach(async () => {
  globalThis.__formicMemoryStore = undefined;
  jar.clear();
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("FORMIC_ALLOWED_USERS", "");
  resetEnvCache();
  const user = await repository().upsertUser({ githubId: 1, login: "a", name: null, avatarUrl: null });
  userId = user.id;
  jar.set(SESSION_COOKIE, await signSession(userId));
});

describe("/api/settings run time budget", () => {
  it("returns the default with no stored setting", async () => {
    const body = await (await GET()).json();
    expect(body.mode).toBe("PER_STORY_POINT");
    expect(body.flatMinutes ?? null).toBeNull();
    expect(body.perPointMinutes ?? null).toBeNull();
  });

  it("stores flat minutes and returns them on later reads", async () => {
    const res = await PUT(put({ mode: "FLAT_MINUTES", flatMinutes: 30 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "FLAT_MINUTES", flatMinutes: 30 });
    expect(await (await GET()).json()).toMatchObject({ mode: "FLAT_MINUTES", flatMinutes: 30 });
  });

  it("stores per-point values", async () => {
    const res = await PUT(put({ mode: "PER_POINT", perPointMinutes: { "1": 5, "3": 20 } }));
    expect(res.status).toBe(200);
    expect((await (await GET()).json()).perPointMinutes).toEqual({ 1: 5, 3: 20 });
  });

  it.each([
    ["flat minutes below 1", { mode: "FLAT_MINUTES", flatMinutes: 0 }, "flatMinutes"],
    ["a per-point entry that is not a positive integer", { mode: "PER_POINT", perPointMinutes: { "1": 1.5 } }, "perPointMinutes"],
    ["a per-point key that is not a whole number", { mode: "PER_POINT", perPointMinutes: { "1.5": 5 } }, "perPointMinutes"],
    ["an empty per-point map", { mode: "PER_POINT", perPointMinutes: {} }, "perPointMinutes"],
    ["a missing per-point map", { mode: "PER_POINT" }, "perPointMinutes"],
  ])("rejects %s and leaves the stored setting", async (_name, payload, field) => {
    await PUT(put({ mode: "FLAT_MINUTES", flatMinutes: 30 }));
    const res = await PUT(put(payload));
    expect(res.status).toBe(400);
    expect((await res.json()).errors[field]).toBeTruthy();
    expect(await (await GET()).json()).toMatchObject({ mode: "FLAT_MINUTES", flatMinutes: 30 });
  });

  it("rejects an unknown mode", async () => {
    expect((await PUT(put({ mode: "WEEKLY" }))).status).toBe(400);
  });

  it("refuses without a session", async () => {
    jar.clear();
    expect((await GET()).status).toBe(401);
    expect((await PUT(put({ mode: "OFF" }))).status).toBe(401);
  });
});
