import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { proxy } from "@/proxy";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { CURRENT_TERMS_VERSION } from "@/lib/auth/user";
import { repository } from "@/lib/db";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.x");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "secret");
  vi.stubEnv("FORMIC_SECRET", "s");
});

afterEach(() => vi.unstubAllEnvs());

const withCookie = (url: string, cookie: string, method = "GET") =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });

describe("logout", () => {
  it("ends a copy of the session cookie too", async () => {
    const repo = repository();
    const user = await repo.upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    await repo.acceptTerms(user.id, CURRENT_TERMS_VERSION);
    const cookie = await signSession(user.id, Date.now(), user.sessionVersion);
    expect((await proxy(withCookie("/api/board", cookie))).status).toBe(200);

    await POST(withCookie("/api/auth/logout", cookie, "POST"));

    expect((await proxy(withCookie("/api/board", cookie))).status).toBe(401);
  });

  it("does nothing for a cookie that is already signed out", async () => {
    const repo = repository();
    const user = await repo.upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    const stale = await signSession(user.id, Date.now(), user.sessionVersion);
    await repo.bumpSessionVersion(user.id);
    await POST(withCookie("/api/auth/logout", stale, "POST"));
    expect((await repo.userById(user.id))?.sessionVersion).toBe(1);
  });
});
