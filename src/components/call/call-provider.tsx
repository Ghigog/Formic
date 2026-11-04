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
import { guestOptions, type GuestId } from "@/lib/meetings/guests";
import { detectAddGuest, HELLO_ASK, isHelloEveryone, resolveAddressee } from "@/components/call/routing";
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
  /** Who can be brought in, at the colony's level. */
  options: { id: GuestId; label: string }[];
  /** The guest whose reply is pending or being read aloud. */
  active: GuestId | null;
  muted: boolean;
  /** Epoch ms the call started, or null when there is none. */
  startedAt: number | null;
  mic: MicState;
  /** Starts the call; `guest` is who is on it first, besides the PM. */
  start: (guest?: GuestId) => void;
  addGuest: (id: GuestId) => void;
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
  unlockAllSentinels = false,
  children,
}: {
  assistant: AssistantControls;
  /** Tests pass a FakeEngine; the board gets the browser's. */
  engine?: CallEngine;
  unlockAllSentinels?: boolean;
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
  const [guests, setGuests] = useState<GuestId[]>(["assistant"]);
  const guestsRef = useRef(guests);
  const lastSpeaker = useRef<GuestId | null>(null);
  const [speakingGuest, setSpeakingGuest] = useState<GuestId | null>(null);
  const [reading, setReading] = useState(false);
  const level = colony?.score.level ?? 1;
  const options = useMemo(() => guestOptions(level, unlockAllSentinels), [level, unlockAllSentinels]);

  const a = useRef(assistant);
  useEffect(() => {
    a.current = assistant;
    guestsRef.current = guests;
  });
  const spoken = useRef(new Set<string>());
  const asked = useRef(false);
  const lookingSaid = useRef(false);
  const utterance = useRef(0);

  const say = useCallback(
    (text: string, who: GuestId | null = null) => {
      if (!engine || !text) return;
      const mine = ++utterance.current;
      setSpeakingGuest(who);
      setSpeaking(true);
      setReading(who !== null);
      void engine.speak(text).then(() => {
        if (who !== null) setReading(false);
        // A later utterance replaces this one: only the last clears the state.
        if (utterance.current === mine) setSpeaking(false);
      });
    },
    [engine],
  );

  const addGuest = useCallback((id: GuestId) => {
    if (guestsRef.current.includes(id)) return;
    guestsRef.current = [...guestsRef.current, id];
    setGuests(guestsRef.current);
    sfxRef.current?.("ring");
  }, []);

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
    const added = detectAddGuest(next!);
    if (added && !guestsRef.current.includes(added)) {
      addGuest(added);
      setSending(false);
      return;
    }
    if (isHelloEveryone(next!)) {
      void a.current
        .ask(`${next!.trim()} ${HELLO_ASK}`, guestsRef.current)
        .finally(() => setSending(false));
      return;
    }
    const speaker = resolveAddressee(next!, guestsRef.current, lastSpeaker.current);
    lastSpeaker.current = speaker;
    const turn = speaker === "assistant" ? a.current.ask(next!) : a.current.ask(next!, [speaker]);
    void turn.finally(() => setSending(false));
  }, [live, sending, pending, queue, say, addGuest]);

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

  // Read each new finished reply aloud, once, in order: each waits for the one before.
  useEffect(() => {
    if (!live || reading) return;
    const next = assistant.messages.find((m) => m.role === "assistant" && !spoken.current.has(m.id));
    if (!next || next.status === "pending") return;
    spoken.current.add(next.id);
    // Until the person has spoken, what arrives is the chat's history loading.
    if (!asked.current || next.status !== "done") return;
    const who = (next.speaker as GuestId | undefined) ?? "assistant";
    const waiting = undecided([next]);
    say(
      waiting
        ? `${waiting.open.map(({ p }) => sentence(p.summary)).join(" ")} Shall I?`
        : plain(next.content),
      who,
    );
  }, [live, reading, assistant.messages, say]);

  const start = useCallback((guest?: GuestId) => {
    if (!engine?.supported || live) return;
    engine.start(); // inside the tap: iOS speaks only after a gesture
    silenceMutter(true);
    spoken.current = new Set(a.current.messages.map((m) => m.id));
    const first = guest && guest !== "assistant" ? guest : null;
    guestsRef.current = first ? ["assistant", first] : ["assistant"];
    setGuests(guestsRef.current);
    lastSpeaker.current = first;
    // The opener is the PM's own reply, read aloud like any other.
    asked.current = !!first || !!a.current.openCall;
    lookingSaid.current = false;
    setQueue([]);
    setMutedState(false);
    setStartedAt(Date.now());
    setLive(true);
    a.current.setOpen(true);
    if (first) void a.current.ask("Hello!", [first]);
    else void a.current.openCall?.();
  }, [engine, live]);

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

  // The guest whose reply is being read, else the one a reply is pending from.
  const waitingOn = assistant.messages.find((m) => m.role === "assistant" && m.status === "pending");
  const active: GuestId | null = !live
    ? null
    : speaking && speakingGuest
      ? speakingGuest
      : waitingOn
        ? ((waitingOn.speaker as GuestId | undefined) ?? "assistant")
        : null;

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
      options,
      active,
      muted,
      startedAt,
      mic,
      start,
      addGuest,
      hangUp,
      setMuted,
    }),
    [live, engine, guests, options, active, muted, startedAt, mic, start, addGuest, hangUp, setMuted],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
