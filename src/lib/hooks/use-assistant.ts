"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One message, as the assistant API returns it. */
export interface AssistantMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "pending" | "failed";
  proposals: Array<{
    summary: string;
    action: {
      type: "create_backlog_item" | "create_epic_with_tickets";
      title?: string;
      request?: string;
      tickets?: Array<{ key: string; title: string; dependsOn: string[] }>;
    };
    state: "proposed" | "applied" | "dismissed" | "failed";
    error?: string;
  }>;
}

interface State {
  presetId: string | null;
  messages: AssistantMessageView[];
}

async function send(
  url: string,
  method: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<State> {
  const res = await fetch(url, {
    method,
    signal,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    (State & { error?: string }) | null;
  if (!res.ok || !data)
    throw new Error(data?.error ?? "That did not go through. Try again.");
  return data;
}

/** How often to look for an answer while one is being written. */
const POLL_MS = 4_000;

/**
 * The board's assistant conversation. Loads when first opened, and while an
 * answer is pending checks back until it lands: an API agent answers in
 * seconds, a CLI agent in GitHub Actions in a minute or two.
 */
export function useAssistant(enabled: boolean) {
  const [state, setState] = useState<State>({ presetId: null, messages: [] });
  const loaded = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const [asking, setAsking] = useState(false);
  const asked = useRef<AbortController | null>(null);

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
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!enabled || loaded.current) return;
    loaded.current = true;
    void run(() => send("/api/assistant", "GET"));
  }, [enabled, run]);

  const answering = state.messages.some((m) => m.status === "pending");
  const pending = asking || answering;
  useEffect(() => {
    if (!answering) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void send("/api/assistant", "GET")
        .then((next) => alive.current && setState(next))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [answering]);

  const ask = useCallback(
    async (text: string) => {
      const controller = new AbortController();
      asked.current = controller;
      setAsking(true);
      try {
        await run(() =>
          send("/api/assistant", "POST", { text }, controller.signal),
        );
      } finally {
        if (asked.current === controller) asked.current = null;
        if (alive.current && !controller.signal.aborted) setAsking(false);
      }
    },
    [run],
  );
  /** Give up on the question being sent; the box is free again at once. */
  const stop = useCallback(() => {
    asked.current?.abort();
    asked.current = null;
    setAsking(false);
    setError(null);
    // The POST only enqueues the answer: cancel it on the server too.
    void run(() => send("/api/assistant", "PATCH"));
  }, [run]);
  const clear = useCallback(
    () => run(() => send("/api/assistant", "DELETE")),
    [run],
  );
  const decide = useCallback(
    (messageId: string, index: number, decision: "apply" | "dismiss") =>
      run(() =>
        send("/api/assistant/proposals", "POST", {
          messageId,
          index,
          decision,
        }),
      ),
    [run],
  );
  const setAgent = useCallback(async (presetId: string | null) => {
    setError(null);
    const res = await fetch("/api/assistant/agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presetId }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(data?.error ?? "Could not change the agent.");
      return;
    }
    setState((s) => ({ ...s, presetId }));
  }, []);

  return { ...state, pending, error, ask, stop, clear, decide, setAgent };
}
