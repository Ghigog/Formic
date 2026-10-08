import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HIDDEN_GRACE_MS,
  PING_SETTLE_MS,
  REALTIME_FALLBACK_MS,
  REFUSED_RETRY_MS,
  useBoardEvents,
} from "./use-board-events";

const realtime = vi.hoisted(() => ({
  clients: [] as Array<{ url: string; apikey: string; topic?: string; ping?: () => void; status?: (s: string) => void; gone: boolean }>,
}));

vi.mock("@supabase/realtime-js", () => ({
  RealtimeClient: class {
    entry: (typeof realtime.clients)[number];
    constructor(url: string, opts: { params: { apikey: string } }) {
      this.entry = { url, apikey: opts.params.apikey, gone: false };
      realtime.clients.push(this.entry);
    }
    channel(topic: string) {
      const entry = this.entry;
      entry.topic = topic;
      const ch = {
        on(_type: string, _filter: unknown, fn: () => void) {
          entry.ping = fn;
          return ch;
        },
        subscribe(fn: (s: string) => void) {
          entry.status = fn;
          return ch;
        },
      };
      return ch;
    }
    removeChannel() {
      return Promise.resolve();
    }
    disconnect() {
      this.entry.gone = true;
    }
  },
}));

/** What the first look answers: by default, no Realtime, so the board streams. */
let looks: Array<{ status?: number; body?: unknown }> = [];
let channel: unknown = null;
const fetchMock = vi.fn(async (_url: string) => {
  const next = looks.shift() ?? { body: { events: [], through: 0, realtime: channel } };
  return {
    ok: (next.status ?? 200) < 300 && next.status !== 204,
    status: next.status ?? 200,
    json: async () => next.body,
  } as Response;
});

/** Lets the first look's promises settle. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

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
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  looks = [];
  channel = null;
  realtime.clients = [];
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBoardEvents", () => {
  it("closes the stream once the tab has been hidden a while, and resumes from its cursor", async () => {
    const seen: number[] = [];
    renderHook(() => useBoardEvents((_e, seq) => seen.push(seq)));
    await settle();
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

  it("keeps the stream through a quick switch away and back", async () => {
    renderHook(() => useBoardEvents(() => {}));
    await settle();
    act(() => setHidden(true));
    act(() => vi.advanceTimersByTime(HIDDEN_GRACE_MS / 2));
    act(() => setHidden(false));
    act(() => vi.advanceTimersByTime(HIDDEN_GRACE_MS));
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0]!.closed).toBe(false);
  });

  it("does not show a planned close after a pause frame as reconnecting, and keeps its cursor", async () => {
    const { result } = renderHook(() => useBoardEvents(() => {}));
    await settle();
    const source = FakeSource.all[0]!;
    act(() => source.onopen?.());
    act(() => source.emit("stream.pause", 57));
    act(() => source.onerror?.());
    expect(result.current).toBe("open");

    // A reconnect that then fails is a real error.
    act(() => source.onerror?.());
    expect(result.current).toBe("reconnecting");
  });

  it("opens again, later, a stream the server refused", async () => {
    renderHook(() => useBoardEvents(() => {}));
    await settle();
    const refused = FakeSource.all[0]!;
    refused.readyState = FakeSource.CLOSED;
    act(() => refused.onerror?.());
    act(() => vi.advanceTimersByTime(REFUSED_RETRY_MS - 1));
    expect(FakeSource.all).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeSource.all).toHaveLength(2);
    expect(refused.closed).toBe(true);
  });

  describe("with Supabase Realtime", () => {
    const info = { url: "https://abc.supabase.co", key: "anon", topic: "formic-t" };
    beforeEach(() => {
      channel = info;
    });

    it("joins the board's channel and looks once each time it hears of a change", async () => {
      const seen: number[] = [];
      looks = [{ body: { events: [], through: 7, realtime: info } }];
      const { result } = renderHook(() => useBoardEvents((_e, seq) => seen.push(seq)));
      await settle();
      await settle();

      expect(FakeSource.all).toHaveLength(0);
      const client = realtime.clients[0]!;
      expect(client.url).toBe("wss://abc.supabase.co/realtime/v1");
      expect(client.topic).toBe("formic-t");
      expect(result.current).toBe("open");

      act(() => client.status!("SUBSCRIBED"));
      await settle();
      // Joining catches up once, from the cursor.
      expect(fetchMock).toHaveBeenLastCalledWith("/api/events?format=json&lastEventId=7", { cache: "no-store" });

      looks = [{ body: { events: [{ seq: 9, event: { type: "card.status" } }], through: 9, realtime: info } }];
      act(() => {
        client.ping!();
        client.ping!();
      });
      const before = fetchMock.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(PING_SETTLE_MS));
      expect(fetchMock.mock.calls.length).toBe(before + 1);
      expect(seen).toEqual([9]);
    });

    it("looks rarely while joined, and every few seconds while not", async () => {
      looks = [{ body: { events: [], through: 1, realtime: info } }];
      renderHook(() => useBoardEvents(() => {}));
      await settle();
      await settle();
      const client = realtime.clients[0]!;

      // Not joined yet: looks again soon.
      const a = fetchMock.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(15_000));
      expect(fetchMock.mock.calls.length).toBe(a + 1);

      act(() => client.status!("SUBSCRIBED"));
      await settle();
      const b = fetchMock.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(REALTIME_FALLBACK_MS - 1_000));
      expect(fetchMock.mock.calls.length).toBe(b);
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(fetchMock.mock.calls.length).toBe(b + 1);
    });

    it("leaves the channel when the tab has been hidden a while", async () => {
      looks = [{ body: { events: [], through: 1, realtime: info } }];
      renderHook(() => useBoardEvents(() => {}));
      await settle();
      await settle();
      act(() => setHidden(true));
      await act(() => vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS));
      expect(realtime.clients[0]!.gone).toBe(true);
    });
  });
});
