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

async function send(url: string, method: string, body?: unknown): Promise<State> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (State & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? "That did not go through. Try again.");
  return data;
}

/** How often to look for an answer while one is being written. */
const POLL_MS = 2_000;

/**
 * The board's assistant conversation. Loads when first opened, and while an
 * answer is pending checks back until it lands: an API agent answers in
 * seconds, a CLI agent in GitHub Actions in a minute or two.
 */
export function useAssistant(enabled: boolean) {
  const [state, setState] = useState<State>({ presetId: null, messages: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (work: () => Promise<State>) => {
    setError(null);
    try {
      const next = await work();
      if (alive.current) setState(next);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!enabled || loaded) return;
    setLoaded(true);
    void run(() => send("/api/assistant", "GET"));
  }, [enabled, loaded, run]);

  const pending = state.messages.some((m) => m.status === "pending");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void send("/api/assistant", "GET")
        .then((next) => alive.current && setState(next))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const ask = useCallback(
    (text: string) => run(() => send("/api/assistant", "POST", { text })),
    [run],
  );
  const clear = useCallback(() => run(() => send("/api/assistant", "DELETE")), [run]);
  const decide = useCallback(
    (messageId: string, index: number, decision: "apply" | "dismiss") =>
      run(() => send("/api/assistant/proposals", "POST", { messageId, index, decision })),
    [run],
  );
  const setAgent = useCallback(
    async (presetId: string | null) => {
      setError(null);
      const res = await fetch("/api/assistant/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not change the agent.");
        return;
      }
      setState((s) => ({ ...s, presetId }));
    },
    [],
  );

  return { ...state, pending, error, ask, clear, decide, setAgent };
}
