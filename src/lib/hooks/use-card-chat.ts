"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One message, as a card's chat API returns it. */
export interface CardChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "pending" | "failed";
}

interface State {
  messages: CardChatMessageView[];
}

async function send(url: string, method: string, body?: unknown): Promise<State> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (Partial<State> & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? "That did not go through. Try again.");
  return { messages: Array.isArray(data.messages) ? data.messages : [] };
}

/** How often to look for an answer while one is being written. */
const POLL_MS = 2_000;

/**
 * One card's chat with the agent that runs its column now: loads when the
 * drawer opens, and while an answer is pending checks back until it lands.
 */
export function useCardChat(kind: "epic" | "ticket", cardId: string | null) {
  const url = cardId ? `/api/${kind === "epic" ? "epics" : "tickets"}/${cardId}/chat` : null;
  const [state, setState] = useState<State>({ messages: [] });
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
  }, []);

  useEffect(() => {
    if (!url || loadedFor.current === url) return;
    loadedFor.current = url;
    setState({ messages: [] });
    void run(() => send(url, "GET"));
  }, [url, run]);

  const pending = state.messages.some((m) => m.status === "pending");
  useEffect(() => {
    if (!pending || !url) return;
    const timer = setInterval(() => {
      void send(url, "GET")
        .then((next) => alive.current && setState(next))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, url]);

  const ask = useCallback(
    (text: string) => (url ? run(() => send(url, "POST", { text })) : Promise.resolve()),
    [run, url],
  );
  const clear = useCallback(() => (url ? run(() => send(url, "DELETE")) : Promise.resolve()), [run, url]);

  return { ...state, pending, error, ask, clear };
}
