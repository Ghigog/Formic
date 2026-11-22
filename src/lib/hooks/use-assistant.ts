"use client";

import { mergeMessages } from "./merge-messages";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentSummary } from "@/lib/domain/entities";
import type { MessageKind } from "@/lib/domain/chat";
import type { SubscribeToEvents } from "@/components/board/ticket-drawer";

/** One message, as the assistant API returns it. */
export interface AssistantMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "pending" | "failed";
  /** Who a reply is from: "assistant", a column role or "sentinel:<id>". */
  speaker?: string;
  /** person, pm, guest or notice (Formic's own word, a timeline line). Implied by role and speaker when absent. */
  kind?: MessageKind;
  /** When it was written (ISO). */
  createdAt?: string;
  /** Cards it links to. */
  cards?: Array<{ id: string; key: string; title: string }>;
  /** Pictures sent with it. */
  attachments?: AttachmentSummary[];
  proposals: Array<{
    summary: string;
    action: {
      type:
        | "create_backlog_item"
        | "create_todo_item"
        | "create_epic_with_tickets"
        | "add_tickets_to_epic"
        | "rerun_ci"
        | "update_branch"
        | "open_pull_request"
        | "move_card"
        | "close_card"
        | "revise_rubric_check";
      /** revise_rubric_check: the check's wording now, and the proposed change. */
      current?: string;
      proposed?: string;
      title?: string;
      request?: string;
      /** open_pull_request: what the pull request says. */
      body?: string;
      tickets?: Array<{ key: string; title: string; dependsOn: string[] }>;
    };
    state: "proposed" | "applied" | "dismissed" | "failed";
    error?: string;
  }>;
}

interface State {
  presetId: string | null;
  /** When the person last read the chat (ISO), or null if never. */
  readAt?: string | null;
  messages: AssistantMessageView[];
  /** The id to pass as ?before= for the page before these, or null when nothing is earlier. */
  earlierCursor?: string | null;
}

async function send(
  url: string,
  method: string,
  body?: unknown,
): Promise<State> {
  const res = await fetch(url, {
    method,
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
export function useAssistant(enabled: boolean, subscribe?: SubscribeToEvents) {
  const [state, setStateRaw] = useState<State>({ presetId: null, messages: [] });
  // Earlier pages live apart from the polled newest page, so a poll cannot drop them.
  const [earlier, setEarlier] = useState<{ messages: AssistantMessageView[]; cursor: string | null } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  /** A new newest page: a conversation that was cleared starts over. */
  const setState = useCallback((next: State) => {
    setStateRaw(next);
    if (next.messages.length === 0) setEarlier(null);
  }, []);
  const loaded = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const [asking, setAsking] = useState(false);

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
    if (!enabled || loaded.current) return;
    loaded.current = true;
    void run(() => send("/api/assistant", "GET"));
  }, [enabled, run]);

  /** Fetches the conversation now and returns it, for a caller that needs it before going on. */
  const load = useCallback(async (): Promise<AssistantMessageView[]> => {
    loaded.current = true;
    try {
      const next = await send("/api/assistant", "GET");
      if (alive.current) {
        setError(null);
        setState(next);
      }
      return next.messages;
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, [setState]);

  // A message the PM writes unasked lands as an event: refetch the newest page,
  // once the chat has been opened. A burst shares the fetch already running.
  const refetching = useRef(false);
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.type !== "assistant.message" && event.type !== "assistant.failed") return;
      if (!loaded.current || refetching.current) return;
      refetching.current = true;
      void send("/api/assistant", "GET")
        .then((next) => alive.current && setState(next))
        .catch(() => undefined)
        .finally(() => {
          refetching.current = false;
        });
    });
  }, [subscribe, setState]);

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
  }, [answering, setState]);

  const ask = useCallback(
    async (text: string, speakers?: string[], requestId?: string) => {
      setAsking(true);
      try {
        await run(() =>
          send("/api/assistant", "POST", {
            text,
            ...(speakers ? { speakers } : {}),
            ...(requestId ? { requestId } : {}),
          }),
        );
      } finally {
        if (alive.current) setAsking(false);
      }
    },
    [run],
  );
  /**
   * The person pressed Stop on one pending reply. Only that reply stops, as
   * "Stopped."; sending another message never stops one, it queues.
   */
  const stop = useCallback(
    (messageId: string) => {
      setError(null);
      void run(() => send("/api/assistant", "PATCH", { messageId }));
    },
    [run],
  );
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
    setStateRaw((s) => ({ ...s, presetId }));
  }, []);

  const cursor = earlier ? earlier.cursor : (state.earlierCursor ?? null);
  const loadEarlier = useCallback(async () => {
    if (!cursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingEarlier(true);
    setEarlierError(null);
    try {
      const page = await send(`/api/assistant?before=${encodeURIComponent(cursor)}`, "GET");
      if (!alive.current) return;
      setEarlier((prev) => ({
        messages: mergeMessages(page.messages, prev?.messages ?? []),
        cursor: page.earlierCursor ?? null,
      }));
    } catch (e) {
      if (alive.current) setEarlierError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      if (alive.current) setLoadingEarlier(false);
    }
  }, [cursor]);

  return {
    presetId: state.presetId,
    messages: mergeMessages(earlier?.messages ?? [], state.messages),
    pending,
    error,
    ask,
    stop,
    clear,
    decide,
    load,
    setAgent,
    hasEarlier: cursor !== null,
    loadingEarlier,
    earlierError,
    loadEarlier,
  };
}
