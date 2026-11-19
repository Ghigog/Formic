import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { PlaytestProvider, usePlaytest, type PlaytestApi } from "./playtest-context";

const m = vi.hoisted(() => ({ unlocked: true }));
vi.mock("@/components/colony/colony", () => ({
  useColony: () => ({ featureUnlocked: () => m.unlocked, setTimelineOpen: vi.fn(), setSentinelsOpen: vi.fn() }),
}));
vi.mock("./playtest-screen", () => ({ PlaytestScreen: () => <div data-testid="screen" /> }));


let replies: Record<string, { status?: number; body: unknown }> = {};
beforeEach(() => {
  m.unlocked = true;
  replies = {
    "GET /api/playtest": { body: { access: { ok: true }, session: null } },
    "POST /api/playtest": { status: 201, body: { session: { id: "pt1", status: "starting" } } },
    "DELETE /api/playtest/pt1": { body: { session: { id: "pt1", status: "ended" } } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const r = replies[`${init?.method ?? "GET"} ${url}`] ?? { status: 404, body: {} };
      return Response.json(r.body, { status: r.status ?? 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Mounts the provider; the returned getter reads what it gives its children. */
function mount(): () => PlaytestApi {
  let api: PlaytestApi | null = null;
  function Probe() {
    api = usePlaytest();
    return null;
  }
  render(
    <PlaytestProvider repoName="game" projectId="p1">
      <Probe />
    </PlaytestProvider>,
  );
  return () => api!;
}

describe("PlaytestProvider", () => {
  it("reads access once unlocked, and not before", async () => {
    m.unlocked = false;
    let get = mount();
    await new Promise((r) => setTimeout(r, 10));
    expect(get().access).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    cleanup();
    m.unlocked = true;
    get = mount();
    await waitFor(() => expect(get().access).toEqual({ ok: true }));
  });

  it("opens the screen and starts a session, then stops it", async () => {
    const get = mount();
    await waitFor(() => expect(get().access).toEqual({ ok: true }));
    act(() => get().open());
    await waitFor(() => expect(get().session?.id).toBe("pt1"));
    expect(get().screenOpen).toBe(true);
    await act(() => get().stop());
    expect(get().session?.status).toBe("ended");
    act(() => get().close());
    expect(get().screenOpen).toBe(false);
  });

  it("keeps the reason a start was refused", async () => {
    replies["POST /api/playtest"] = { status: 403, body: { error: "Add your key." } };
    const get = mount();
    await act(() => get().start());
    expect(get().startError).toBe("Add your key.");
  });
});
