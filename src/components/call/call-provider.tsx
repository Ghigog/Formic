"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useColony } from "@/components/colony/colony";
import { silenceMutter } from "@/components/onboarding/voice";
import type { AssistantControls } from "@/components/board/assistant";
import type { GuestId } from "@/lib/meetings/guests";
import { mergeHint, spokenDecision } from "@/components/call/approvals";
import { createBrowserEngine, type CallEngine } from "@/lib/voice/engine";

/** What the PM says while a look-up runs, once per wait. */
export const LOOKING_NOW = "Looking now";

export const UNSUPPORTED_TITLE =
  "Calls need speech recognition, which this browser does not have. Try Chrome, Edge or Safari.";

export type MicState = "listening" | "thinking" | "speaking" | "muted";

export interface CallApi {
  live: boolean;
  /** False where the browser cannot recognise speech. */
  supported: boolean;
  guests: GuestId[];
  muted: boolean;
  /** Epoch ms the call started, or null when there is none. */
  startedAt: number | null;
  mic: MicState;
  start: () => void;
  hangUp: () => void;
  setMuted: (muted: boolean) => void;
}

const noSubscription = () => () => {};

const Ctx = createContext<CallApi | null>(null);

/** The call, or null where there is no board around it (tests, other pages). */
export function useCall(): CallApi | null {
  return useContext(Ctx);
}

/** Seconds as the call clock shows them: 3:12, or 1:02:09 past the hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The elapsed call time, ticking each second. */
export function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return formatElapsed(startedAt === null ? 0 : now - startedAt);
}

/** Markdown read aloud sounds like noise: keep the words. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first proposal in the newest reply that still waits on the person, with the ones after it. */
function undecided(messages: AssistantControls["messages"]) {
  const m = messages.at(-1);
  if (!m || m.role !== "assistant" || m.status !== "done") return null;
  const open = m.proposals.map((p, index) => ({ p, index })).filter(({ p }) => p.state === "proposed");
  return open.length > 0 ? { id: m.id, open } : null;
}

/** A proposal read aloud: its summary in one sentence. */
function sentence(summary: string): string {
  return summary.trim().replace(/[.!?]*$/, ".");
}

/**
 * The call on the PM chat. The person talks, each finished turn goes through
 * the assistant like a typed message (queued behind a pending answer, never
 * blocked), and each new reply is read aloud once.
 */
export function CallProvider({
  assistant,
  engine: given,
  children,
}: {
  assistant: AssistantControls;
  /** Tests pass a FakeEngine; the board gets the browser's. */
  engine?: CallEngine;
  children: ReactNode;
}) {
  const colony = useColony();
  const sfx = colony?.sfx;
  // The browser's engine exists only on the client, made once; the server
  // render (and the first client one) has none, so the phone starts disabled.
  const made = useRef<CallEngine | null>(null);
  const sfxRef = useRef(sfx);
  useEffect(() => {
    sfxRef.current = sfx;
  });
  const engine = useSyncExternalStore(
    noSubscription,
    () =>
      given ??
      (made.current ??= createBrowserEngine({
        sfx: (n) => sfxRef.current?.(n),
      })),
    () => null,
  );

  const [live, setLive] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const guests = useMemo<GuestId[]>(() => ["assistant"], []);

  const a = useRef(assistant);
  useEffect(() => {
    a.current = assistant;
  });
  const spoken = useRef(new Set<string>());
  const asked = useRef(false);
  const lookingSaid = useRef(false);
  const utterance = useRef(0);

  const say = useCallback(
    (text: string) => {
      if (!engine || !text) return;
      const mine = ++utterance.current;
      setSpeaking(true);
      void engine.speak(text).then(() => {
        // A later utterance replaces this one: only the last clears the state.
        if (utterance.current === mine) setSpeaking(false);
      });
    },
    [engine],
  );

  // Turns queue; the effect below sends one when the PM is free.
  useEffect(() => {
    if (!engine || !live) return;
    return engine.onTurn((text) => setQueue((q) => [...q, text]));
  }, [engine, live]);

  const pending = assistant.pending;
  useEffect(() => {
    if (!live || sending || pending || queue.length === 0) return;
    const [next, ...rest] = queue;
    // Proposals read aloud wait on a spoken yes or no before it is a message.
    const waiting = undecided(a.current.messages);
    const first = waiting?.open[0];
    const decision = first ? spokenDecision(next!, first.p) : "none";
    /* eslint-disable react-hooks/set-state-in-effect -- one turn leaves the queue as the PM frees up */
    setQueue(rest);
    setSending(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    asked.current = true;
    // A spoken yes or no is answered at once, not with "Looking now".
    const local = decision !== "none" || (first && mergeHint(next!, first.p));
    if (local) lookingSaid.current = true;
    if (waiting && first && decision !== "none") {
      void a.current
        .decide(waiting.id, first.index, decision === "approve" ? "apply" : "dismiss")
        .finally(() => setSending(false));
      const more = waiting.open[1];
      say(
        [decision === "approve" ? "Approved." : "Dismissed.", more ? `${sentence(more.p.summary)} Shall I?` : ""]
          .filter(Boolean)
          .join(" "),
      );
      return;
    }
    const hint = first ? mergeHint(next!, first.p) : null;
    if (hint) {
      say(hint);
      setSending(false);
      return;
    }
    void a.current.ask(next!).finally(() => setSending(false));
  }, [live, sending, pending, queue, say]);

  // "Looking now", once per wait.
  useEffect(() => {
    if (!live) return;
    if (!pending && queue.length === 0) {
      lookingSaid.current = false;
      return;
    }
    if (lookingSaid.current) return;
    lookingSaid.current = true;
    say(LOOKING_NOW);
  }, [live, pending, queue.length, say]);

  // Read each new finished reply aloud, once.
  const last = assistant.messages.at(-1);
  useEffect(() => {
    if (
      !live ||
      !last ||
      last.status === "pending" ||
      spoken.current.has(last.id)
    )
      return;
    if (last.role !== "assistant") return;
    spoken.current.add(last.id);
    // Until the person has spoken, what arrives is the chat's history loading.
    if (!asked.current || last.status !== "done") return;
    const waiting = undecided([last]);
    say(
      waiting
        ? `${waiting.open.map(({ p }) => sentence(p.summary)).join(" ")} Shall I?`
        : plain(last.content),
    );
  }, [live, last, say]);

  const start = useCallback(() => {
    if (!engine?.supported || live) return;
    engine.start(); // inside the tap: iOS speaks only after a gesture
    silenceMutter(true);
    spoken.current = new Set(last ? [last.id] : []);
    // The opener is the PM's own reply, read aloud like any other.
    asked.current = !!a.current.openCall;
    lookingSaid.current = false;
    setQueue([]);
    setMutedState(false);
    setStartedAt(Date.now());
    setLive(true);
    a.current.setOpen(true);
    void a.current.openCall?.();
  }, [engine, live, last]);

  const hangUp = useCallback(() => {
    if (!live) return;
    engine?.stop();
    silenceMutter(false);
    setLive(false);
    setSpeaking(false);
    setQueue([]);
    setStartedAt(null);
  }, [engine, live]);

  // Leaving the board hangs up.
  useEffect(
    () => () => {
      engine?.stop();
      silenceMutter(false);
    },
    [engine],
  );

  const setMuted = useCallback(
    (m: boolean) => {
      engine?.mute(m);
      setMutedState(m);
    },
    [engine],
  );

  const mic: MicState = muted
    ? "muted"
    : speaking
      ? "speaking"
      : pending || queue.length > 0
        ? "thinking"
        : "listening";

  const api = useMemo<CallApi>(
    () => ({
      live,
      supported: engine?.supported ?? false,
      guests,
      muted,
      startedAt,
      mic,
      start,
      hangUp,
      setMuted,
    }),
    [live, engine, guests, muted, startedAt, mic, start, hangUp, setMuted],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
