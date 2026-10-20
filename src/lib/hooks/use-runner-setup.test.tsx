import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { FormicEvent } from "@/lib/domain/events";
import { useRunnerSetup } from "./use-runner-setup";

type Listener = (event: FormicEvent, seq: number) => void;

function bus() {
  const listeners = new Set<Listener>();
  return {
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (event: FormicEvent) => listeners.forEach((l) => l(event, 1)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const waiting = { state: "waiting", setupUrl: "https://github.com/o/r/pull/1", update: false };

describe("useRunnerSetup", () => {
  it("starts unknown, then reports what the endpoint says", async () => {
    const fetchMock = vi.fn(async () => Response.json(waiting));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRunnerSetup(bus().subscribe));
    expect(result.current.setup).toBeNull();
    await waitFor(() => expect(result.current.setup).toEqual(waiting));
    expect(fetchMock).toHaveBeenCalledWith("/api/runner/setup", { cache: "no-store" });
  });

  it("stays unknown when the request fails or the body is not a setup", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const { result, unmount } = renderHook(() => useRunnerSetup(bus().subscribe));
    await act(() => result.current.check());
    expect(result.current.setup).toBeNull();
    unmount();

    vi.stubGlobal("fetch", async () => new Response("nope"));
    const second = renderHook(() => useRunnerSetup(bus().subscribe));
    await act(() => second.result.current.check());
    expect(second.result.current.setup).toBeNull();
  });

  it("becomes ready on the runner.ready event", async () => {
    vi.stubGlobal("fetch", async () => Response.json(waiting));
    const b = bus();
    const { result } = renderHook(() => useRunnerSetup(b.subscribe));
    await waitFor(() => expect(result.current.setup?.state).toBe("waiting"));
    act(() => b.emit({ type: "runner.ready" } as FormicEvent));
    expect(result.current.setup).toEqual({ state: "ready" });
  });

  it("asks again on a timer and when the tab returns, only while waiting", async () => {
    const fetchMock = vi.fn(async () => Response.json(waiting));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const { result } = renderHook(() => useRunnerSetup(bus().subscribe));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.setup?.state).toBe("waiting");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockImplementation(async () => Response.json({ state: "ready" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(result.current.setup).toEqual({ state: "ready" });
    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
});
