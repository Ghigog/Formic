"use client";

import { mergeMessages } from "./merge-messages";
import { useCallback, useEffect, useRef, useState } from "react";

/** One message, as a card's chat API returns it. */
export interface CardChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "pending" | "failed";
  /**
   * What the answer spent, when Formic made it rather than a CLI agent in
   * GitHub Actions: an answer is not a run, so this is the only record of it.
   * Zero or absent means nothing to show.
   */
  tokensIn?: number;
  tokensOut?: number;
  costCents?: number;
}

interface State {
  messages: CardChatMessageView[];
  /** The id to pass as ?before= for the page before these, or null when nothing is earlier. */
  earlierCursor: string | null;
}

async function send(url: string, method: string, body?: unknown): Promise<State> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (Partial<State> & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? "That did not go through. Try again.");
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    earlierCursor: data.earlierCursor ?? null,
  };
}

/** How often to look for an answer while one is being written. */
const POLL_MS = 4_000;

/**
 * One card's chat with the agent that runs its column now: loads when the
 * drawer opens, and while an answer is pending checks back until it lands.
 */
export function useCardChat(kind: "epic" | "ticket", cardId: string | null) {
  const url = cardId ? `/api/${kind === "epic" ? "epics" : "tickets"}/${cardId}/chat` : null;
  const [state, setStateRaw] = useState<State>({ messages: [], earlierCursor: null });
  // Earlier pages live apart from the polled newest page, so a poll cannot drop them.
  const [earlier, setEarlier] = useState<{ messages: CardChatMessageView[]; cursor: string | null } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  /** A new newest page: a chat that was cleared or emptied starts over. */
  const setState = useCallback((next: State) => {
    setStateRaw(next);
    if (next.messages.length === 0) setEarlier(null);
  }, []);
  const loadedFor = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (work: () => Promise<State>) => {
    try {
      const next = await work();
      if (!alive.current) return;
      setError(null);
      setState(next);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [setState]);

  useEffect(() => {
    if (!url || loadedFor.current === url) return;
    loadedFor.current = url;
    setState({ messages: [], earlierCursor: null });
    setEarlier(null);
    setEarlierError(null);
    void run(() => send(url, "GET"));
  }, [url, run, setState]);

  const pending = state.messages.some((m) => m.status === "pending");
  useEffect(() => {
    if (!pending || !url) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void send(url, "GET")
        .then((next) => alive.current && setState(next))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, url, setState]);

  const ask = useCallback(
    (text: string) => (url ? run(() => send(url, "POST", { text })) : Promise.resolve()),
    [run, url],
  );
  const clear = useCallback(() => (url ? run(() => send(url, "DELETE")) : Promise.resolve()), [run, url]);

  const cursor = earlier ? earlier.cursor : state.earlierCursor;
  const loadEarlier = useCallback(async () => {
    if (!url || !cursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingEarlier(true);
    setEarlierError(null);
    try {
      const page = await send(`${url}?before=${encodeURIComponent(cursor)}`, "GET");
      if (!alive.current) return;
      setEarlier((prev) => ({
        messages: mergeMessages(page.messages, prev?.messages ?? []),
        cursor: page.earlierCursor,
      }));
    } catch (e) {
      if (alive.current) setEarlierError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      if (alive.current) setLoadingEarlier(false);
    }
  }, [url, cursor]);

  return {
    messages: mergeMessages(earlier?.messages ?? [], state.messages),
    pending,
    error,
    ask,
    clear,
    hasEarlier: cursor !== null,
    loadingEarlier,
    earlierError,
    loadEarlier,
  };
}
