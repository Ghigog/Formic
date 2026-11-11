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

const REFETCH_DEBOUNCE_MS = 120;
/** A failed refresh is tried again after 2 s, 4 s, 8 s, 16 s, 32 s. */
const REFETCH_RETRY_MS = 2_000;
const REFETCH_RETRIES = 5;
/** How often a visible board looks again on its own. */
export const CATCH_UP_MS = 60_000;

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
  // Each look is numbered. Only the latest one started may set the cards: an
  // older, slower answer arriving last would put the board back as it was.
  const latestLook = useRef(0);

  const refetch = useCallback(async () => {
    const look = ++latestLook.current;
    const res = await fetch("/api/board", { cache: "no-store" });
    if (!res.ok) throw new Error(`Board refresh failed (${res.status})`);
    const data = (await res.json()) as { cards: BoardCard[] };
    if (look !== latestLook.current) return;
    setCards(data.cards);
  }, []);

  // A look that fails is tried again, so the board never keeps showing a
  // move it heard about but could not fetch.
  const scheduleRefetch = useCallback(() => {
    const at = (delay: number, attempt: number) => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        refetch().catch(() => {
          if (attempt < REFETCH_RETRIES) at(REFETCH_RETRY_MS * 2 ** attempt, attempt + 1);
        });
      }, delay);
    };
    at(REFETCH_DEBOUNCE_MS, 0);
  }, [refetch]);

  // A catch-up look while the board is on screen, in case an event was missed.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") scheduleRefetch();
    }, CATCH_UP_MS);
    return () => clearInterval(timer);
  }, [scheduleRefetch]);

  const onEvent = useCallback(
    (event: FormicEvent, seq: number) => {
      other.current?.(event, seq);
      switch (event.type) {
        case "card.status":
        case "card.created":
        case "card.deleted":
          scheduleRefetch();
          break;

        case "card.queen":
          setCards((prev) => prev.map((c) => (c.id === event.cardId ? { ...c, queen: true } : c)));
          break;

        case "card.chat":
          // A card's chat being answered is work on the card even though
          // nothing about it moves: the colony reads that off here.
          setExtras((prev) => ({
            ...prev,
            [event.cardId]: {
              ...prev[event.cardId],
              answering: event.state === "answering",
            },
          }));
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
      let result: TransitionResult | null = null;
      try {
        const res = await fetch("/api/transitions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(t),
        });
        result = (await res.json().catch(() => null)) as TransitionResult | null;
      } catch {
        // Network failure: handled like an unreadable answer.
      }
      if (!result) {
        void refetch().catch(() => {});
        return {
          ok: false,
          reason: "The server did not respond to that move.",
          revertTo: t.from,
        };
      }

      // Awaited so the board swaps its optimistic copy for fresh server state
      // in one render, rather than flashing the card back where it came from.
      try {
        await refetch();
      } catch {
        return result.ok
          ? {
              ok: false,
              reason: "Could not refresh the board after that move.",
              revertTo: t.from,
            }
          : result;
      }
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
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
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
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
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
