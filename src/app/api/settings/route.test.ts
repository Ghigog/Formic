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

describe("/api/settings token and attempt limits", () => {
  it("returns defaults for a person with no stored limits", async () => {
    const body = await (await GET()).json();
    expect(body.mode).toBe("PER_STORY_POINT");
    expect(body.tokens).toEqual({ mode: "PER_POINT", perPoint: 64_000 });
    expect(body.attempts).toEqual({ mode: "FLAT" });
  });

  it("stores each axis and returns it on later reads", async () => {
    const res = await PUT(
      put({
        mode: "PER_STORY_POINT",
        tokens: { mode: "FLAT", flat: 300000 },
        attempts: { mode: "PER_POINT_BY_HAND", byHand: { "1": 2, "5": 6 } },
      }),
    );
    expect(res.status).toBe(200);
    expect(await (await GET()).json()).toMatchObject({
      tokens: { mode: "FLAT", flat: 300000 },
      attempts: { mode: "PER_POINT_BY_HAND", byHand: { 1: 2, 5: 6 } },
    });
  });

  it("returns Off for tokens when Off was chosen, not the default", async () => {
    await PUT(put({ mode: "PER_STORY_POINT", tokens: { mode: "OFF" } }));
    const body = await (await GET()).json();
    expect(body.tokens).toEqual({ mode: "OFF" });
    expect(body.attempts).toEqual({ mode: "FLAT" });
  });

  it("leaves an axis alone when the request omits it", async () => {
    await PUT(put({ mode: "OFF", tokens: { mode: "FLAT", flat: 5000 } }));
    await PUT(put({ mode: "OFF", attempts: { mode: "FLAT", flat: 3 } }));
    expect(await (await GET()).json()).toMatchObject({
      tokens: { mode: "FLAT", flat: 5000 },
      attempts: { mode: "FLAT", flat: 3 },
    });
  });

  it.each([
    ["a cents field at the top", { mode: "OFF", maxCents: 500 }],
    ["a cents field on an axis", { mode: "OFF", tokens: { mode: "FLAT", flat: 1000, cents: 500 } }],
    ["an unknown axis mode", { mode: "OFF", tokens: { mode: "WEEKLY" } }],
    ["a flat axis with no value", { mode: "OFF", attempts: { mode: "FLAT" } }],
    ["a fractional per-point value", { mode: "OFF", tokens: { mode: "PER_POINT", perPoint: 1.5 } }],
  ])("rejects %s and stores nothing", async (_name, payload) => {
    const res = await PUT(put(payload));
    expect(res.status).toBe(400);
    const body = await (await GET()).json();
    expect(body.tokens).toEqual({ mode: "PER_POINT", perPoint: 64_000 });
    expect(body.mode).toBe("PER_STORY_POINT");
  });
});
