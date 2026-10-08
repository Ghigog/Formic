"use client";

import { useEffect, useRef, useState } from "react";
import { STREAM_PAUSE_EVENT, type FormicEvent, type SequencedEvent } from "@/lib/domain/events";

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
 */

/** How long to wait before opening a stream the server refused outright. */
export const REFUSED_RETRY_MS = 5 * 60_000;

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

  useEffect(() => {
    if (!enabled || !visible) return;

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
  }, [enabled, visible, attempt]);

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
