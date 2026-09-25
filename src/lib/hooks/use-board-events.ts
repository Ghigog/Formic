"use client";

import { useEffect, useRef, useState } from "react";
import type { FormicEvent, SequencedEvent } from "@/lib/domain/events";

/**
 * Subscribes to the project event stream.
 *
 * EventSource reconnects on its own and replays Last-Event-ID, so the cursor
 * work is handled by the browser. What this adds is a mirrored cursor for the
 * first connection after a full page load, and a connection state the UI can
 * show rather than silently going stale.
 */

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

  useEffect(() => {
    if (!enabled) return;

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
    ];
    for (const t of types) source.addEventListener(t, onMessage as EventListener);

    source.onopen = () => setState("open");
    source.onerror = () => setState("reconnecting");

    return () => {
      for (const t of types)
        source.removeEventListener(t, onMessage as EventListener);
      source.close();
    };
  }, [enabled]);

  return state;
}
