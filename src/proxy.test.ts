import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { repository } from "@/lib/db";
import { CURRENT_TERMS_VERSION } from "@/lib/auth/user";
import { dailyBudget, resetGovernorForTests, utcDay } from "@/lib/usage/governor";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  resetGovernorForTests();
});

afterEach(() => vi.unstubAllEnvs());

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

function githubMode() {
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.x");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "secret");
  vi.stubEnv("FORMIC_SECRET", "s");
}

describe("proxy", () => {
  it("sends a signed-out visitor to sign in, remembering where they were", async () => {
    githubMode();
    const res = await proxy(request("/settings"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login?next=%2Fsettings");
  });

  it("answers the API with 401 rather than a redirect", async () => {
    githubMode();
    expect((await proxy(request("/api/board"))).status).toBe(401);
  });

  it("lets a signed-in person through", async () => {
    githubMode();
    const user = await repository().upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    await repository().acceptTerms(user.id, CURRENT_TERMS_VERSION);
    const res = await proxy(request("/api/board", await signSession(user.id)));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps sign-in, health, the webhook and the runner's own addresses open", async () => {
    githubMode();
    for (const path of [
      "/login",
      "/api/auth/github/login",
      "/api/health",
      "/api/webhooks/github",
      "/api/runner/report",
      "/api/runner/bundle",
    ]) {
      expect((await proxy(request(path))).headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("is open in local mode with no password", async () => {
    expect((await proxy(request("/"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("sends someone who hasn't accepted the current terms to /legal, remembering where they were", async () => {
    githubMode();
    const user = await repository().upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    const cookie = await signSession(user.id);

    const res = await proxy(request("/settings", cookie));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/legal?next=%2Fsettings");
  });

  it("answers the API with 403 when the current terms are not yet accepted", async () => {
    githubMode();
    const user = await repository().upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    expect((await proxy(request("/api/board", await signSession(user.id)))).status).toBe(403);
  });

  it("keeps /legal itself open to someone who hasn't accepted yet", async () => {
    githubMode();
    const user = await repository().upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    const cookie = await signSession(user.id);
    for (const path of ["/legal", "/legal/accept"]) {
      expect((await proxy(request(path, cookie))).headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("lets someone who accepted the current terms through to the board", async () => {
    githubMode();
    const user = await repository().upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    await repository().acceptTerms(user.id, CURRENT_TERMS_VERSION);
    const res = await proxy(request("/settings", await signSession(user.id)));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("asks again once the terms version moves on", async () => {
    githubMode();
    const user = await repository().upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    await repository().acceptTerms(user.id, "2020-01-01");
    const res = await proxy(request("/settings", await signSession(user.id)));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/legal?next=%2Fsettings");
  });
});

describe("proxy, at the host allowance", () => {
  async function spend(share: number) {
    vi.stubEnv("FORMIC_USAGE_LIMITS", "on");
    const today = utcDay(Date.now());
    await repository().addPlatformUsage(
      today,
      { requests: dailyBudget().requests * share, busyMs: 0, cpuMs: 0 },
      today,
    );
  }

  function post(path: string) {
    return new NextRequest(`http://localhost${path}`, { method: "POST" });
  }

  it("lets everything through with room to spare", async () => {
    await spend(0.1);
    expect((await proxy(post("/api/tickets"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("near the line, refuses new work and the event stream but still serves reads and finishing work", async () => {
    await spend(0.9);
    const refused = await proxy(post("/api/tickets"));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await refused.json()).toMatchObject({ allowance: "heavy" });
    expect((await proxy(request("/api/events"))).status).toBe(503);

    for (const res of [
      await proxy(request("/api/board")),
      await proxy(request("/")),
      await proxy(post("/api/webhooks/github")),
      await proxy(post("/api/runner/report")),
    ]) {
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("at the line, refuses everything but the health check", async () => {
    await spend(1);
    expect((await proxy(request("/api/board"))).status).toBe(503);
    expect((await proxy(request("/"))).status).toBe(503);
    expect((await proxy(post("/api/webhooks/github"))).status).toBe(503);
    expect((await proxy(request("/api/health"))).headers.get("x-middleware-next")).toBe("1");
  });
});
