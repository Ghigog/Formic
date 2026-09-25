"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import type { FormicEvent } from "@/lib/domain/events";
import type { CardTransition, TransitionResult } from "@/lib/domain/transitions";
import type { CardExtras } from "@/components/board/card";
import type { AmbientStats } from "@/components/ui/ambient-drawer";
import { useBoardEvents } from "./use-board-events";

/** Most recent log lines kept for the ambient terminal. */
const LOG_TAIL = 200;

export function useBoard(
  initialCards: BoardCard[],
  initialStats: AmbientStats,
  /** Every event, after the board has taken what it needs from it. */
  onOther?: (event: FormicEvent, seq: number) => void,
) {
  const other = useRef(onOther);
  useEffect(() => {
    other.current = onOther;
  });
  const [cards, setCards] = useState(initialCards);
  // For naming a terminal line by its ticket, without re-binding the stream.
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    keys.current = new Map(cards.map((c) => [c.id, c.key]));
  }, [cards]);
  const [extras, setExtras] = useState<Record<string, CardExtras | undefined>>({});
  const [stats, setStats] = useState(initialStats);
  /** Live PRD text per Epic while the Product Agent writes. */
  const [prdStreams, setPrdStreams] = useState<Record<string, string>>({});

  // Refetch is debounced: a burst of card events should cost one request.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async () => {
    const res = await fetch("/api/board", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { cards: BoardCard[] };
    setCards(data.cards);
  }, []);

  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => void refetch(), 120);
  }, [refetch]);

  const onEvent = useCallback(
    (event: FormicEvent, seq: number) => {
      other.current?.(event, seq);
      switch (event.type) {
        case "card.status":
        case "card.created":
        case "card.deleted":
          scheduleRefetch();
          break;

        case "run.progress":
          if (event.ticketId) {
            const ticketId = event.ticketId;
            setExtras((prev) => ({
              ...prev,
              [ticketId]: {
                ...prev[ticketId],
                progress: { label: event.label, fraction: event.fraction },
              },
            }));
          }
          break;

        case "ci.status":
          setExtras((prev) => ({
            ...prev,
            [event.ticketId]: { ...prev[event.ticketId], ci: event.state },
          }));
          break;

        case "run.log":
          setStats((prev) => ({
            ...prev,
            logLines: [
              ...prev.logLines,
              {
                runId: event.runId,
                label: event.ticketId ? keys.current.get(event.ticketId) : undefined,
                stream: event.stream,
                line: event.line,
              },
            ].slice(-LOG_TAIL),
          }));
          break;

        case "run.usage":
          setStats((prev) => ({
            ...prev,
            tokensIn: prev.tokensIn + event.tokensIn,
            tokensOut: prev.tokensOut + event.tokensOut,
            costCents: prev.costCents + event.costCents,
          }));
          break;

        case "sandbox.count":
          setStats((prev) => ({
            ...prev,
            activeSandboxes: event.active,
            provider: event.provider,
          }));
          break;

        case "epic.prd":
          setPrdStreams((prev) => ({
            ...prev,
            [event.epicId]: event.done ? "" : (prev[event.epicId] ?? "") + event.delta,
          }));
          if (event.done) scheduleRefetch();
          break;

        case "run.finished":
          scheduleRefetch();
          break;

        default:
          break;
      }
    },
    [scheduleRefetch],
  );

  const connection = useBoardEvents(onEvent);

  useEffect(() => {
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, []);

  const transition = useCallback(
    async (t: CardTransition): Promise<TransitionResult> => {
      const res = await fetch("/api/transitions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(t),
      });

      const result = (await res.json().catch(() => null)) as TransitionResult | null;
      if (!result) {
        void refetch();
        return {
          ok: false,
          reason: "The server did not respond to that move.",
          revertTo: t.from,
        };
      }

      // Awaited so the board swaps its optimistic copy for fresh server state
      // in one render, rather than flashing the card back where it came from.
      await refetch();
      return result;
    },
    [refetch],
  );

  const createEpic = useCallback(
    async (rawRequest: string, requestId?: string) => {
      const res = await fetch("/api/epics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawRequest, requestId }),
      });
      await refetch();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not create that backlog item.");
      }
    },
    [refetch],
  );

  const createTicket = useCallback(
    async (rawRequest: string, requestId?: string) => {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawRequest, requestId }),
      });
      await refetch();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not create that ticket.");
      }
    },
    [refetch],
  );

  return {
    cards,
    extras,
    stats,
    prdStreams,
    connection,
    transition,
    createEpic,
    createTicket,
    refetch,
  };
}
