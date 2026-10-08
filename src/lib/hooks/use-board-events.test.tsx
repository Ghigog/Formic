import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_GRACE_MS, REFUSED_RETRY_MS, useBoardEvents } from "./use-board-events";

class FakeSource {
  static all: FakeSource[] = [];
  static CLOSED = 2;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: MessageEvent<string>) => void>();
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, seq: number) {
    this.listeners.get(type)?.({ data: JSON.stringify({ seq, event: { type } }) } as MessageEvent<string>);
  }
}

let hidden = false;
function setHidden(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  hidden = false;
  vi.stubGlobal("EventSource", FakeSource);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBoardEvents", () => {
  it("closes the stream once the tab has been hidden a while, and resumes from its cursor", () => {
    const seen: number[] = [];
    renderHook(() => useBoardEvents((_e, seq) => seen.push(seq)));
    const first = FakeSource.all[0]!;
    expect(first.url).toBe("/api/events");
    act(() => first.emit("card.status", 41));

    act(() => setHidden(true));
    act(() => vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1));
    expect(first.closed).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(first.closed).toBe(true);

    act(() => setHidden(false));
    const second = FakeSource.all[1]!;
    expect(second.url).toBe("/api/events?lastEventId=41");
    expect(seen).toEqual([41]);
  });

  it("keeps the stream through a quick switch away and back", () => {
    renderHook(() => useBoardEvents(() => {}));
    act(() => setHidden(true));
    act(() => vi.advanceTimersByTime(HIDDEN_GRACE_MS / 2));
    act(() => setHidden(false));
    act(() => vi.advanceTimersByTime(HIDDEN_GRACE_MS));
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0]!.closed).toBe(false);
  });

  it("does not show a planned close after a pause frame as reconnecting, and keeps its cursor", () => {
    const { result } = renderHook(() => useBoardEvents(() => {}));
    const source = FakeSource.all[0]!;
    act(() => source.onopen?.());
    act(() => source.emit("stream.pause", 57));
    act(() => source.onerror?.());
    expect(result.current).toBe("open");

    // A reconnect that then fails is a real error.
    act(() => source.onerror?.());
    expect(result.current).toBe("reconnecting");
  });

  it("opens again, later, a stream the server refused", () => {
    renderHook(() => useBoardEvents(() => {}));
    const refused = FakeSource.all[0]!;
    refused.readyState = FakeSource.CLOSED;
    act(() => refused.onerror?.());
    act(() => vi.advanceTimersByTime(REFUSED_RETRY_MS - 1));
    expect(FakeSource.all).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeSource.all).toHaveLength(2);
    expect(refused.closed).toBe(true);
  });
});
