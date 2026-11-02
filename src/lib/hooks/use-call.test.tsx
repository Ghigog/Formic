import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCall } from "./use-call";

const meeting = { id: "m1", title: "Kickoff", agenda: "Plan", guests: [] };
const msg = (status: "done" | "pending" | "failed", content = "") => ({
  id: "a1",
  role: "assistant",
  guestId: null,
  content,
  status,
});

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stubFetch = (handler: (init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => handler(init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

describe("useCall", () => {
  it("loads the meeting and its messages", async () => {
    const fetchMock = stubFetch(() => Response.json({ meeting, messages: [msg("done", "Hello")] }));
    const { result } = renderHook(() => useCall("m1"));
    await flush();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/calls/m1/messages");
    expect(result.current.meeting).toEqual(meeting);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("holds the API's error message when loading fails", async () => {
    stubFetch(() => Response.json({ error: "No such call." }, { status: 404 }));
    const { result } = renderHook(() => useCall("m1"));
    await flush();
    expect(result.current.error).toBe("No such call.");
  });

  it("falls back to a generic message when the error has no body", async () => {
    stubFetch(() => new Response("oops", { status: 500 }));
    const { result } = renderHook(() => useCall("m1"));
    await flush();
    expect(result.current.error).toBe("That did not go through. Try again.");
  });

  it("sends a question and shows the reply, clearing an earlier error", async () => {
    stubFetch((init) =>
      init?.method === "POST"
        ? Response.json({ meeting, messages: [msg("done", "Answer")] })
        : Response.json({ error: "Down." }, { status: 500 }),
    );
    const { result } = renderHook(() => useCall("m1"));
    await flush();
    expect(result.current.error).toBe("Down.");
    await act(() => result.current.ask("Why?"));
    expect(result.current.error).toBeNull();
    expect(result.current.messages[0]!.content).toBe("Answer");
  });

  it("holds the API's message when sending fails", async () => {
    stubFetch((init) =>
      init?.method === "POST" ? Response.json({ error: "Too long." }, { status: 400 }) : Response.json({ meeting, messages: [] }),
    );
    const { result } = renderHook(() => useCall("m1"));
    await flush();
    await act(() => result.current.ask("x"));
    expect(result.current.error).toBe("Too long.");
  });

  it("polls while an answer is pending and stops once it lands", async () => {
    let answered = false;
    const fetchMock = stubFetch(() => Response.json({ meeting, messages: [answered ? msg("done", "Done") : msg("pending")] }));
    const { result } = renderHook(() => useCall("m1"));
    await flush();
    expect(result.current.pending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answered = true;
    await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBe(false);
    expect(result.current.messages[0]!.content).toBe("Done");

    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a failed poll", async () => {
    let fail = true;
    const fetchMock = stubFetch(() =>
      fail && fetchMock.mock.calls.length > 1 ? Response.error() : Response.json({ meeting, messages: [msg("pending")] }),
    );
    const { result } = renderHook(() => useCall("m1"));
    await flush();
    await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
    expect(result.current.error).toBeNull();
    fail = false;
    await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("skips the poll while the tab is hidden", async () => {
    const fetchMock = stubFetch(() => Response.json({ meeting, messages: [msg("pending")] }));
    renderHook(() => useCall("m1"));
    await flush();
    visibility = "hidden";
    await act(async () => void (await vi.advanceTimersByTimeAsync(12_000)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not set state after unmount", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubFetch(async () => {
      await gate;
      return Response.json({ meeting, messages: [msg("done", "late")] });
    });
    const { result, unmount } = renderHook(() => useCall("m1"));
    unmount();
    release();
    await flush();
    expect(result.current.meeting).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});
