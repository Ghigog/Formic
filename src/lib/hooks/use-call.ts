"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { GuestId } from "@/lib/calls/guests";

/** One message in a call, as the call API returns it. */
export interface CallMessageView {
  id: string;
  role: "user" | "assistant";
  guestId: GuestId | null;
  content: string;
  status: "done" | "pending" | "failed";
}

export interface CallMeetingView {
  id: string;
  title: string;
  agenda: string;
  guests: GuestId[];
}

interface State {
  meeting: CallMeetingView | null;
  messages: CallMessageView[];
}

async function send(url: string, method: string, body?: unknown): Promise<State> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (Partial<State> & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? "That did not go through. Try again.");
  return { meeting: data.meeting ?? null, messages: Array.isArray(data.messages) ? data.messages : [] };
}

/** How often to look for an answer while one is being written. */
const POLL_MS = 4_000;

/** One call: loads its agenda and messages, and while an answer is pending checks back until it lands. */
export function useCall(meetingId: string) {
  const url = `/api/calls/${meetingId}/messages`;
  const [state, setState] = useState<State>({ meeting: null, messages: [] });
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
    send(url, "GET")
      .then((next) => alive.current && (setError(null), setState(next)))
      .catch((e) => alive.current && setError(e instanceof Error ? e.message : String(e)));
  }, [url]);

  const pending = state.messages.some((m) => m.status === "pending");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void send(url, "GET")
        .then((next) => alive.current && setState(next))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, url]);

  const ask = useCallback((text: string) => run(() => send(url, "POST", { text })), [run, url]);

  return { ...state, pending, error, ask };
}
