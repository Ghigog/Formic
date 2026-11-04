import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
}));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, signSession } = await import("@/lib/auth/session");
const { seal } = await import("@/lib/secrets/vault");
const { resetEnvCache } = await import("@/lib/secrets/env");
const { DELETE } = await import("./route");

const PROFILE = { githubId: 7, login: "octo", name: null, avatarUrl: null };

async function actAs(userId: string) {
  jar.clear();
  jar.set(SESSION_COOKIE, await signSession(userId));
}

let revoked: string[];

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_MAILER", "console");
  vi.stubEnv("FORMIC_SECRET", "s".repeat(32));
  vi.stubEnv("FORMIC_ALLOWED_USERS", "");
  resetEnvCache();
  revoked = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).includes("/applications/") && init.method === "DELETE") {
      revoked.push(JSON.parse(String(init.body)).access_token);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe("DELETE /api/account/github", () => {
  it("refuses an unauthenticated request", async () => {
    expect((await DELETE()).status).toBe(401);
  });

  it("revokes the token at GitHub and forgets the connection, keeping the account", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    await repository().linkGithub(ana.id, PROFILE);
    await repository().updateUser(ana.id, { githubTokenCipher: seal("gho_ana"), githubRefreshCipher: seal("ghr_ana") });
    await actAs(ana.id);

    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(revoked).toEqual(["gho_ana"]);
    const after = await repository().userById(ana.id);
    expect(after).toMatchObject({ githubId: null, githubTokenCipher: null, githubRefreshCipher: null, email: "ana@example.com" });
  });

  it("refuses for someone whose only way in is GitHub", async () => {
    const octo = await repository().upsertUser(PROFILE);
    await repository().updateUser(octo.id, { githubTokenCipher: seal("gho_octo") });
    await actAs(octo.id);

    const res = await DELETE();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Delete your account");
    expect(revoked).toEqual([]);
    expect((await repository().userById(octo.id))?.githubId).toBe(7);
  });

  it("does nothing for an account with no GitHub", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    await actAs(ana.id);
    expect((await DELETE()).status).toBe(200);
    expect(revoked).toEqual([]);
  });
});
