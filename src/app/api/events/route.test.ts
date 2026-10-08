import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SequencedEvent } from "@/lib/domain/events";

/**
 * The board's event stream: a reconnect replays from its cursor, an event that
 * arrives twice (bus and durable tail) is sent once, events from another
 * instance arrive through the tail, and a closed tab unsubscribes. The bus and
 * the sweeps the tail kicks off are mocked; their own tests cover them.
 */

const mocks = vi.hoisted(() => ({
  project: { id: "p1" } as { id: string } | null,
  subscribers: [] as Array<(e: unknown) => void>,
  unsubscribe: vi.fn(),
  replay: vi.fn(async (): Promise<unknown[]> => []),
  latestEventSeq: vi.fn(async () => 10),
  realtime: false,
}));

vi.mock("@/lib/board/project", () => ({ activeProject: async () => mocks.project }));
vi.mock("@/lib/db", () => ({
  repository: () => ({ latestEventSeq: mocks.latestEventSeq }),
}));
vi.mock("@/lib/events/bus", () => ({
  isDroppable: () => false,
  replay: mocks.replay,
  subscribe: (_project: string, fn: (e: unknown) => void) => {
    mocks.subscribers.push(fn);
    return mocks.unsubscribe;
  },
}));
vi.mock("@/lib/agents/pipeline", () => ({ fromStream: (work: () => Promise<void>) => work() }));
vi.mock("@/lib/runner/runner", () => ({ collectCliRuns: vi.fn(async () => undefined) }));
vi.mock("@/lib/review/pipeline", () => ({ sweepOpenPullRequests: vi.fn(async () => undefined) }));
vi.mock("@/lib/board/idle", () => ({ sweepIdleCards: vi.fn(async () => undefined) }));
vi.mock("@/lib/events/realtime", () => ({
  realtimeConfig: () => (mocks.realtime ? { url: "https://abc.supabase.co", key: "anon" } : null),
  realtimeTopic: async (id: string) => `formic-${id}`,
}));

const { GET } = await import("./route");

function event(seq: number): SequencedEvent {
  return { seq, event: { type: "card.moved" } } as unknown as SequencedEvent;
}

function open(headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const req = new NextRequest("http://localhost/api/events", { headers, signal: abort.signal });
  return { abort, response: GET(req) };
}

/** Reads frames until `count` event frames have arrived, ignoring comments. */
async function frames(res: Response, count: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: string[] = [];
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const frame of decoder.decode(value).split("\n\n")) {
      if (frame.startsWith("id: ")) out.push(frame.split("\n")[0]!);
    }
  }
  reader.releaseLock();
  return out;
}

beforeEach(() => {
  mocks.project = { id: "p1" };
  mocks.subscribers.length = 0;
  mocks.unsubscribe.mockClear();
  mocks.replay.mockReset().mockResolvedValue([]);
  mocks.latestEventSeq.mockClear();
  mocks.realtime = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/events", () => {
  it("answers 204 when there is no board, so the browser stops reconnecting", async () => {
    mocks.project = null;

    const res = await open().response;

    expect(res.status).toBe(204);
  });

  it("streams live events as SSE frames, once each", async () => {
    const { response } = open();
    const res = await response;
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    await vi.waitFor(() => expect(mocks.subscribers).toHaveLength(1));
    mocks.subscribers[0]!(event(11));
    mocks.subscribers[0]!(event(11));
    mocks.subscribers[0]!(event(12));

    expect(await frames(res, 2)).toEqual(["id: 11", "id: 12"]);
    // A fresh connection tails from the log's head, and replays nothing.
    expect(mocks.latestEventSeq).toHaveBeenCalledWith("p1");
    expect(mocks.replay).not.toHaveBeenCalled();
  });

  it("replays what a reconnect missed from its Last-Event-ID, before anything live", async () => {
    mocks.replay.mockResolvedValueOnce([event(4), event(5)]);
    const res = await open({ "last-event-id": "3" }).response;

    await vi.waitFor(() => expect(mocks.subscribers).toHaveLength(1));
    mocks.subscribers[0]!(event(5));
    mocks.subscribers[0]!(event(6));

    expect(await frames(res, 3)).toEqual(["id: 4", "id: 5", "id: 6"]);
    expect(mocks.replay).toHaveBeenCalledWith("p1", 3);
    expect(mocks.latestEventSeq).not.toHaveBeenCalled();
  });

  it("tails the durable log for events published in another instance", async () => {
    vi.useFakeTimers();
    const res = await open().response;
    await vi.waitFor(() => expect(mocks.subscribers).toHaveLength(1));

    mocks.replay.mockResolvedValueOnce([event(11)]);
    await vi.advanceTimersByTimeAsync(5_000);
    mocks.replay.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await frames(res, 1)).toEqual(["id: 11"]);
    expect(mocks.replay.mock.calls).toEqual([
      ["p1", 10],
      ["p1", 11],
    ]);
  });

  it("unsubscribes and closes when the client goes away", async () => {
    const { abort, response } = open();
    const res = await response;
    await vi.waitFor(() => expect(mocks.subscribers).toHaveLength(1));

    abort.abort();

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    const reader = res.body!.getReader();
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  describe("on a serverless host", () => {
    beforeEach(() => vi.stubEnv("FORMIC_EVENTS", "poll"));

    it("answers at once with what was missed, then a pause frame that moves the cursor", async () => {
      mocks.replay.mockResolvedValueOnce([event(4), event(5)]);
      const res = await open({ "last-event-id": "3" }).response;

      const body = await res.text();
      expect(body.startsWith("retry: 15000\n\n")).toBe(true);
      expect(body).toContain("id: 4\nevent: card.moved");
      expect(body.trimEnd().endsWith('id: 5\nevent: stream.pause\ndata: {"seq":5}')).toBe(true);
      expect(mocks.subscribers).toHaveLength(0);
    });

    it("starts a fresh connection's cursor at the log's head", async () => {
      const body = await (await open().response).text();
      expect(mocks.replay).not.toHaveBeenCalled();
      expect(body).toContain("id: 10\nevent: stream.pause");
    });
  });

  describe("one look as JSON", () => {
    function look(cursor?: number) {
      const q = cursor ? `&lastEventId=${cursor}` : "";
      return GET(new NextRequest(`http://localhost/api/events?format=json${q}`));
    }

    it("answers what was missed, the cursor to come back with, and the board's channel", async () => {
      mocks.realtime = true;
      mocks.replay.mockResolvedValueOnce([event(4), event(5)]);
      const body = await (await look(3)).json();
      expect(body.events.map((e: SequencedEvent) => e.seq)).toEqual([4, 5]);
      expect(body.through).toBe(5);
      expect(body.realtime).toEqual({ url: "https://abc.supabase.co", key: "anon", topic: "formic-p1" });
    });

    it("says there is no channel when Realtime is not set up, and starts a fresh board at the head", async () => {
      const body = await (await look()).json();
      expect(body).toEqual({ events: [], through: 10, realtime: null });
    });
  });
});
