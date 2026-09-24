import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";

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
    const res = await proxy(request("/api/board", await signSession("user_1")));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps sign-in, health, the webhook and runner reports open", async () => {
    githubMode();
    for (const path of ["/login", "/api/auth/github/login", "/api/health", "/api/webhooks/github", "/api/runner/report"]) {
      expect((await proxy(request(path))).headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("is open in local mode with no password", async () => {
    expect((await proxy(request("/"))).headers.get("x-middleware-next")).toBe("1");
  });
});
