"use client";

import { useEffect, useRef, useState } from "react";
import {
  STREAM_PAUSE_EVENT,
  STREAM_POLL_MS,
  type FormicEvent,
  type SequencedEvent,
} from "@/lib/domain/events";

/**
 * Subscribes to the project event stream.
 *
 * EventSource reconnects on its own and replays Last-Event-ID, so the cursor
 * work is handled by the browser. What this adds is a mirrored cursor for the
 * first connection after a full page load, and a connection state the UI can
 * show rather than silently going stale.
 *
 * The stream closes while the tab is hidden and reopens from the cursor when
 * it is shown again, so nothing is missed. An open stream is a server holding
 * a connection and polling the event log for as long as it lasts, and a board
 * left in a background tab all day costs as much as one being watched.
 *
 * On a serverless host the server ends each connection on purpose after a
 * pause frame, and the browser reconnects a little later (see
 * src/app/api/events/route.ts). That close is not shown as reconnecting.
 *
 * With Supabase Realtime set up (src/lib/events/realtime.ts) there is no
 * stream at all: the board listens on its Realtime channel and looks at
 * /api/events once each time it hears something changed, and every
 * REALTIME_FALLBACK_MS in case a message was missed. Until the channel is
 * joined it looks every STREAM_POLL_MS instead. The first look says which
 * way this board works.
 */

/** How long to wait before opening a stream the server refused outright. */
export const REFUSED_RETRY_MS = 5 * 60_000;

/** While joined to its Realtime channel, a board still looks this often. */
export const REALTIME_FALLBACK_MS = 2 * 60_000;
/** A burst of "changed" messages costs one look. */
export const PING_SETTLE_MS = 500;

interface RealtimeChannelInfo {
  url: string;
  key: string;
  topic: string;
}

interface Look {
  events: SequencedEvent[];
  through: number;
  realtime: RealtimeChannelInfo | null;
}

/** How long a tab stays hidden before its stream is closed: a quick tab switch keeps it. */
export const HIDDEN_GRACE_MS = 60_000;

export type ConnectionState = "connecting" | "open" | "reconnecting";

export function useBoardEvents(
  onEvent: (event: FormicEvent, seq: number) => void,
  enabled = true,
) {
  const [state, setState] = useState<ConnectionState>("connecting");
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });

  const cursor = useRef(0);
  const visible = useVisibleAfterGrace(HIDDEN_GRACE_MS);
  // Bumped to open again a stream the server refused (a 503 while the host
  // allowance is nearly spent), which EventSource never retries by itself.
  const [attempt, setAttempt] = useState(0);
  // "probe" until the first look says whether Realtime is set up.
  const [mode, setMode] = useState<"probe" | "realtime" | "stream">("probe");

  useEffect(() => {
    if (!enabled || !visible || mode === "stream") return;

    let live = true;
    let joined = false;
    let looking = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let leave: (() => void) | undefined;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void look(), ms);
    };

    const look = async (): Promise<void> => {
      if (!live) return;
      if (looking) {
        again = true;
        return;
      }
      looking = true;
      try {
        const res = await fetch(`/api/events?format=json&lastEventId=${cursor.current}`, {
          cache: "no-store",
        });
        if (!live) return;
        // No board: nothing to watch.
        if (res.status === 204) return;
        if (!res.ok) {
          setState("reconnecting");
          schedule(res.status === 503 ? REFUSED_RETRY_MS : STREAM_POLL_MS);
          return;
        }
        const body = (await res.json()) as Look;
        if (!live) return;
        if (!body.realtime) {
          setMode("stream");
          return;
        }
        for (const e of body.events) {
          cursor.current = Math.max(cursor.current, e.seq);
          handler.current(e.event, e.seq);
        }
        cursor.current = Math.max(cursor.current, body.through);
        setState("open");
        if (!leave) leave = join(body.realtime);
        schedule(joined ? REALTIME_FALLBACK_MS : STREAM_POLL_MS);
      } catch {
        if (!live) return;
        setState("reconnecting");
        schedule(STREAM_POLL_MS);
      } finally {
        looking = false;
        if (again && live) {
          again = false;
          void look();
        }
      }
    };

    const join = (info: RealtimeChannelInfo): (() => void) => {
      let gone = false;
      let cleanup: (() => void) | undefined;
      void import("@supabase/realtime-js")
        .then(({ RealtimeClient }) => {
          if (gone) return;
          const client = new RealtimeClient(`${info.url.replace(/^http/, "ws")}/realtime/v1`, {
            params: { apikey: info.key },
          });
          const channel = client.channel(info.topic);
          channel
            .on("broadcast", { event: "changed" }, () => {
              clearTimeout(settle);
              settle = setTimeout(() => void look(), PING_SETTLE_MS);
            })
            .subscribe((status) => {
              const was = joined;
              joined = status === "SUBSCRIBED";
              // Joining catches up on anything that changed meanwhile.
              if (joined && !was) void look();
              if (!joined && was) schedule(STREAM_POLL_MS);
            });
          cleanup = () => {
            void client.removeChannel(channel);
            client.disconnect();
          };
        })
        .catch(() => {
          // Realtime unreachable: the board keeps looking every STREAM_POLL_MS.
        });
      return () => {
        gone = true;
        cleanup?.();
      };
    };

    void look();
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(settle);
      leave?.();
    };
  }, [enabled, visible, mode, attempt]);

  useEffect(() => {
    if (!enabled || !visible || mode !== "stream") return;

    const url = cursor.current
      ? `/api/events?lastEventId=${cursor.current}`
      : "/api/events";
    const source = new EventSource(url);

    const onMessage = (raw: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(raw.data) as SequencedEvent;
        cursor.current = Math.max(cursor.current, parsed.seq);
        handler.current(parsed.event, parsed.seq);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };

    // Named events do not arrive on `message`, so every type is bound.
    const types: FormicEvent["type"][] = [
      "card.status",
      "card.created",
      "card.deleted",
      "card.rerouted",
      "card.queen",
      "card.chat",
      "assistant.failed",
      "epic.prd",
      "epic.showcase",
      "run.progress",
      "run.log",
      "run.thought",
      "ticket.plan",
      "ticket.note",
      "ticket.reply",
      "run.diff",
      "run.usage",
      "run.finished",
      "ci.status",
      "sandbox.count",
      "budget.exhausted",
      "agent.limited",
      "runner.ready",
    ];
    for (const t of types) source.addEventListener(t, onMessage as EventListener);

    // The close after a pause frame is planned; only the error it raises is ignored.
    let paused = false;
    const onPause = (raw: MessageEvent<string>) => {
      try {
        const { seq } = JSON.parse(raw.data) as { seq: number };
        cursor.current = Math.max(cursor.current, seq);
      } catch {
        // The browser still keeps the frame's id as its cursor.
      }
      paused = true;
    };
    source.addEventListener(STREAM_PAUSE_EVENT, onPause as EventListener);

    let retry: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => setState("open");
    source.onerror = () => {
      if (paused) {
        paused = false;
        return;
      }
      setState("reconnecting");
      if (source.readyState === EventSource.CLOSED) {
        retry = setTimeout(() => setAttempt((n) => n + 1), REFUSED_RETRY_MS);
      }
    };

    return () => {
      clearTimeout(retry);
      for (const t of types)
        source.removeEventListener(t, onMessage as EventListener);
      source.removeEventListener(STREAM_PAUSE_EVENT, onPause as EventListener);
      source.close();
    };
  }, [enabled, visible, mode, attempt]);

  return state;
}

/**
 * Whether the page is visible, turning false only once it has stayed hidden
 * for `graceMs`, and true again the moment it is shown.
 */
function useVisibleAfterGrace(graceMs: number): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => setVisible(false), graceMs);
      } else {
        setVisible(true);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [graceMs]);
  return visible;
}
