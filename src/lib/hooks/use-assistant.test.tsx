import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAssistant } from "./use-assistant";

afterEach(() => vi.unstubAllGlobals());

const message = (status: "pending" | "failed") => ({
  id: "m",
  role: "assistant",
  content: status === "failed" ? "Stopped." : "",
  status,
  proposals: [],
});

describe("useAssistant stop", () => {
  it("cancels the pending answer after the POST has returned", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      const status = method === "POST" ? "pending" : method === "PATCH" ? "failed" : null;
      return Response.json({ presetId: null, messages: status ? [message(status)] : [] });
    });
    const { result } = renderHook(() => useAssistant(true));
    await act(() => result.current.ask("hi"));
    expect(result.current.pending).toBe(true);
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(calls).toContain("PATCH");
  });
});

describe("useAssistant earlier messages", () => {
  const msg = (id: string, status: "done" | "pending" = "done", content = id) => ({
    id,
    role: "assistant",
    content,
    status,
    proposals: [],
  });

  it("keeps earlier pages through a poll and never shows a message twice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("before=m3")) {
        return Response.json({ presetId: null, messages: [msg("m1"), msg("m2")], earlierCursor: null });
      }
      polls += 1;
      return Response.json(
        polls === 1
          ? { presetId: null, messages: [msg("m3"), msg("m4", "pending", "")], earlierCursor: "m3" }
          : { presetId: null, messages: [msg("m3"), msg("m4", "done", "answer")], earlierCursor: "m3" },
      );
    });
    const { result } = renderHook(() => useAssistant(true));
    await waitFor(() => expect(result.current.hasEarlier).toBe(true));
    await act(() => result.current.loadEarlier());
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(result.current.hasEarlier).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(4_100));
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe("answer"));
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    vi.useRealTimers();
  });

  it("reports a failed load and lets it be tried again", async () => {
    let fail = true;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("before=")) {
        return fail
          ? Response.json({ error: "Nope." }, { status: 500 })
          : Response.json({ presetId: null, messages: [msg("m1")], earlierCursor: null });
      }
      return Response.json({ presetId: null, messages: [msg("m2")], earlierCursor: "m2" });
    });
    const { result } = renderHook(() => useAssistant(true));
    await waitFor(() => expect(result.current.hasEarlier).toBe(true));
    await act(() => result.current.loadEarlier());
    expect(result.current.earlierError).toBe("Nope.");
    expect(result.current.hasEarlier).toBe(true);
    fail = false;
    await act(() => result.current.loadEarlier());
    expect(result.current.earlierError).toBeNull();
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});
