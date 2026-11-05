import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCardChat } from "./use-card-chat";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const msg = (id: string, status: "done" | "pending" = "done", content = id) => ({
  id,
  role: "assistant",
  content,
  status,
});

describe("useCardChat earlier messages", () => {
  it("opens on the newest page, and a poll keeps loaded earlier messages without duplicates", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const urls: string[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.endsWith("?before=m3")) {
        return Response.json({ messages: [msg("m1"), msg("m2")], earlierCursor: null });
      }
      polls += 1;
      return Response.json(
        polls === 1
          ? { messages: [msg("m3"), msg("m4", "pending", "")], earlierCursor: "m3" }
          : { messages: [msg("m3"), msg("m4", "done", "answer")], earlierCursor: "m3" },
      );
    });
    const { result } = renderHook(() => useCardChat("ticket", "t1"));
    await waitFor(() => expect(result.current.hasEarlier).toBe(true));
    expect(result.current.messages.map((m) => m.id)).toEqual(["m3", "m4"]);

    await act(() => result.current.loadEarlier());
    expect(urls).toContain("/api/tickets/t1/chat?before=m3");
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(result.current.hasEarlier).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(4_100));
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe("answer"));
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("has no earlier link for a thread that fits one page", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ messages: [msg("m1")], earlierCursor: null }));
    const { result } = renderHook(() => useCardChat("epic", "e1"));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.hasEarlier).toBe(false);
  });

  it("reports a failed load of earlier messages", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("before=")
        ? Response.json({ error: "Nope." }, { status: 500 })
        : Response.json({ messages: [msg("m2")], earlierCursor: "m2" }),
    );
    const { result } = renderHook(() => useCardChat("ticket", "t1"));
    await waitFor(() => expect(result.current.hasEarlier).toBe(true));
    await act(() => result.current.loadEarlier());
    expect(result.current.earlierError).toBe("Nope.");
    expect(result.current.hasEarlier).toBe(true);
  });
});
