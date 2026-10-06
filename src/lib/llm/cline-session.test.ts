import { afterEach, describe, expect, it, vi } from "vitest";

import { liveToken, refreshSession } from "./cline-session";
import { provider } from "./providers";

/**
 * ClinePass's plan credential is an account session that expires, not an API
 * key. What is proved here is the refreshing of it: which grant is made, what is
 * kept from the reply, and — just as important — that anything which is not a
 * session is left exactly as it was.
 */

const CLINE = provider("clinepass")!;
const DEEPSEEK = provider("deepseek")!;

afterEach(() => vi.unstubAllGlobals());

/** The reply WorkOS gives, in the shape it gives it. */
function granted(access: string, refresh = "rotated-refresh-token") {
  return new Response(
    JSON.stringify({
      access_token: access,
      refresh_token: refresh,
      authentication_method: "password",
      user: {},
    }),
    { status: 200 },
  );
}

describe("a ClinePass plan session", () => {
  it("is exchanged on demand, with the grant the CLI makes", async () => {
    const calls: { url: string; body: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) as Record<string, string> });
        return granted("access-one");
      }),
    );

    expect(await liveToken(CLINE, "session-refresh-one", { force: true })).toBe("access-one");
    expect(calls[0]!.url).toBe("https://api.workos.com/user_management/authenticate");
    expect(calls[0]!.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "session-refresh-one",
      client_id: "client_01K3A541FN8TA3EPPHTD2325AR",
    });
  });

  it("costs nothing until the gateway refuses one, and nothing again once it has a session", async () => {
    const fetch_ = vi.fn(async () => granted("access-two"));
    vi.stubGlobal("fetch", fetch_);

    // The call every turn makes: the credential as it is, no round trip spent.
    expect(await liveToken(CLINE, "session-refresh-two")).toBe("session-refresh-two");
    expect(fetch_).not.toHaveBeenCalled();

    // The gateway refused it, so one grant is made, and its token is held.
    expect(await liveToken(CLINE, "session-refresh-two", { force: true })).toBe("access-two");
    expect(await liveToken(CLINE, "session-refresh-two")).toBe("access-two");
    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it("sends the token the last reply rotated in, not the one that was pasted", async () => {
    const bodies: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as Record<string, string>);
        return granted(`access-${bodies.length}`, `rotated-${bodies.length}`);
      }),
    );

    expect(await liveToken(CLINE, "session-refresh-three", { force: true })).toBe("access-1");
    // Forced again, as a second refusal makes it: the reply retired what was
    // pasted, so the replacement is the only one that still works.
    expect(await liveToken(CLINE, "session-refresh-three", { force: true })).toBe("access-2");
    expect(bodies[1]!.refresh_token).toBe("rotated-1");
  });

  it("is left alone when it is a durable API key", async () => {
    const fetch_ = vi.fn(async () => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetch_);

    // Not a session: the call is made with the key itself…
    expect(await liveToken(CLINE, "a-durable-api-key")).toBe("a-durable-api-key");
    // …a refusal costs one grant, which comes back 400…
    expect(await liveToken(CLINE, "a-durable-api-key", { force: true })).toBe("a-durable-api-key");
    // …and it is never asked again.
    expect(await liveToken(CLINE, "a-durable-api-key", { force: true })).toBe("a-durable-api-key");
    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it("leaves every other provider's credential untouched", async () => {
    const fetch_ = vi.fn();
    vi.stubGlobal("fetch", fetch_);

    expect(await liveToken(DEEPSEEK, "sk-not-cline")).toBe("sk-not-cline");
    expect(fetch_).not.toHaveBeenCalled();
  });

  it("is nothing at all when the grant is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    expect(await refreshSession("not-a-refresh-token")).toBeNull();
  });
});
