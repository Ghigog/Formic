import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A GitLab token lasts two hours; Formic renews it with the refresh token,
 * which GitLab replaces every time. Two lookups racing must share one renewal.
 */

const { repository } = await import("@/lib/db");
const { gitlabTokenFor, storeGitlabTokens, gitlabAuthorizeUrl } = await import("./gitlab");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("GITLAB_CLIENT_ID", "id");
  vi.stubEnv("GITLAB_CLIENT_SECRET", "secret");
  vi.stubEnv("FORMIC_URL", "https://formic.example");
  fetchMock = vi.fn(async () =>
    Response.json({ access_token: "fresh", refresh_token: "r2", expires_in: 7200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function personWith(expiresAt: Date | null) {
  const user = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
  await repository().linkGitlab(user.id, { gitlabId: 5, login: "ana" });
  return storeGitlabTokens(user.id, { accessToken: "old", refreshToken: "r1", expiresAt });
}

describe("gitlabTokenFor", () => {
  it("uses the stored token while it has more than a few minutes left", async () => {
    const user = await personWith(new Date(Date.now() + 60 * 60 * 1000));
    expect(await gitlabTokenFor(user)).toBe("old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews an expiring token once, stores the new pair, and shares the renewal between racing lookups", async () => {
    const user = await personWith(new Date(Date.now() + 60 * 1000));

    const [a, b] = await Promise.all([gitlabTokenFor(user), gitlabTokenFor(user)]);

    expect([a, b]).toEqual(["fresh", "fresh"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "r1",
      redirect_uri: "https://formic.example/api/auth/gitlab/callback",
    });
    const stored = await repository().userById(user.id);
    expect(await gitlabTokenFor(stored!)).toBe("fresh");
  });

  it("gives up, without a token, when GitLab refuses the renewal", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await personWith(new Date(Date.now() - 1000));
    expect(await gitlabTokenFor(user)).toBeNull();
  });
});

describe("gitlabAuthorizeUrl", () => {
  it("asks gitlab.com for the api scope, with the state and the way back", () => {
    const url = new URL(gitlabAuthorizeUrl("nonce", "https://formic.example/api/auth/gitlab/callback"));
    expect(url.origin + url.pathname).toBe("https://gitlab.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "id",
      scope: "api",
      state: "nonce",
      response_type: "code",
      redirect_uri: "https://formic.example/api/auth/gitlab/callback",
    });
  });
});
