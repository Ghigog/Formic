import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_PING_EVERY_MS, pingBoards, realtimeConfig, realtimeTopic, resetRealtimeForTests } from "./realtime";

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 202 }));

beforeEach(() => {
  resetRealtimeForTests();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SUPABASE_URL", "https://abc.supabase.co/");
  vi.stubEnv("SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  vi.stubEnv("FORMIC_SECRET", "x".repeat(32));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("realtimeConfig", () => {
  it("is set up from the Supabase variables, without a trailing slash", () => {
    expect(realtimeConfig()).toEqual({ url: "https://abc.supabase.co", key: "anon" });
  });

  it("is off without a key, with a URL that isn't https, or when turned off", () => {
    vi.stubEnv("SUPABASE_ANON_KEY", "");
    expect(realtimeConfig()).toBeNull();
    vi.stubEnv("SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("SUPABASE_URL", "http://abc.supabase.co");
    expect(realtimeConfig()).toBeNull();
    vi.stubEnv("SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("FORMIC_REALTIME", "off");
    expect(realtimeConfig()).toBeNull();
  });
});

describe("realtimeTopic", () => {
  it("is stable per board, differs between boards, and changes with the secret", async () => {
    const a = await realtimeTopic("p1");
    expect(a).toMatch(/^formic-[0-9a-f]{40}$/);
    expect(await realtimeTopic("p1")).toBe(a);
    expect(await realtimeTopic("p2")).not.toBe(a);
    vi.stubEnv("FORMIC_SECRET", "y".repeat(32));
    expect(await realtimeTopic("p1")).not.toBe(a);
  });
});

describe("pingBoards", () => {
  it("broadcasts an empty change on the board's channel", async () => {
    await pingBoards("p1", false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://abc.supabase.co/realtime/v1/api/broadcast");
    expect((init.headers as Record<string, string>).apikey).toBe("anon");
    expect(JSON.parse(init.body as string)).toEqual({
      messages: [{ topic: await realtimeTopic("p1"), event: "changed", payload: {} }],
    });
  });

  it("sends with the server key when there is one", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    await pingBoards("p1", false);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer service");
  });

  it("sends log-line pings at most every couple of seconds, state changes always", async () => {
    await pingBoards("p1", true, 1_000);
    await pingBoards("p1", true, 1_500);
    await pingBoards("p1", false, 1_600);
    await pingBoards("p1", true, 1_000 + LOG_PING_EVERY_MS + 600);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does nothing without Realtime, and never throws", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    await pingBoards("p1", false);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("SUPABASE_URL", "https://abc.supabase.co");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(pingBoards("p2", false)).resolves.toBeUndefined();
  });
});
