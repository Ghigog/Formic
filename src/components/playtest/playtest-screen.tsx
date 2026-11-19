"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AutoTour } from "@/components/onboarding/tour";
import { ProposalCard } from "@/components/board/assistant";
import { MarkdownLite } from "@/components/ui/markdown-lite";
import { cn } from "@/components/ui/cn";
import { useCountdown } from "@/lib/hooks/use-countdown";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { usePlaytest } from "./playtest-context";
import { PlayIcon } from "./playtest-button";
import { canCaptureTab, captureInFrame, captureTab, rectBetween, uploadShot, type Rect } from "./capture";
import { isOpen, type PastSession, type PlaytestMessage, type PlaytestSession, type PlaytestShot } from "./types";

/**
 * The Playtest screen: the product on the left, the PM on the right, notes
 * at the bottom. See docs/plans/playtest.md, "The Playtest screen".
 */

/** How long after the last note the PM is asked, so a burst of notes gets one answer. */
export const ASK_AFTER_MS = 4000;
const POLL_LIVE_MS = 3000;
const POLL_STARTING_MS = 1500;

const STAGES: Array<{ key: string; label: string }> = [
  { key: "sandbox", label: "Opening a sandbox" },
  { key: "clone", label: "Cloning the default branch" },
  { key: "install", label: "Installing" },
  { key: "start", label: "Starting" },
];

function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const ENDED: Record<string, string> = {
  stopped: "Stopped",
  time: "Out of time",
  closed: "Closed",
  replaced: "Replaced by a newer playtest",
  failed: "Could not start",
  unavailable: "Could not start",
  "needs-config": "Could not start",
};

export function PlaytestScreen() {
  const p = usePlaytest()!;
  const session = p.session;
  const [messages, setMessages] = useState<PlaytestMessage[]>([]);
  const [viewing, setViewing] = useState<{ session: PlaytestSession; messages: PlaytestMessage[] } | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const desktop = useMediaQuery("(min-width: 768px)");
  const frame = useRef<HTMLIFrameElement>(null);
  /** The address whose helper said hello: the current one means screenshots can be taken inside the frame. */
  const [helloFrom, setHelloFrom] = useState<string | null>(null);
  /** The product uses cookies: a sign-in may not stick inside the frame on Safari. */
  const [cookiesFrom, setCookiesFrom] = useState<string | null>(null);
  const [cookieHintClosed, setCookieHintClosed] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [shots, setShots] = useState<PlaytestShot[]>([]);
  const [shotError, setShotError] = useState<string | null>(null);
  const live = session?.status === "live" && !!session.url;
  const left = useCountdown(live ? session!.endsAt : null);
  const origin = live ? new URL(session!.url!).origin : null;
  const helperReady = !!origin && helloFrom === origin;

  // Escape closes the screen; the session keeps running for the board's button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || selecting) return;
      if (sessionsOpen) setSessionsOpen(false);
      else p.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p, selecting, sessionsOpen]);

  // The poll: stage, log, messages. It is also the heartbeat.
  const sessionId = session?.id ?? null;
  const open = isOpen(session);
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/playtest/${sessionId}`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json()) as { session: PlaytestSession; messages: PlaytestMessage[] };
    p.setSession(body.session);
    setMessages(body.messages);
  }, [sessionId, p]);
  useEffect(() => {
    if (!sessionId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first read of a poll; its answer arrives later
    void refresh();
    if (!open) return;
    const t = setInterval(() => void refresh(), session?.status === "starting" ? POLL_STARTING_MS : POLL_LIVE_MS);
    return () => clearInterval(t);
  }, [sessionId, open, session?.status, refresh]);

  // The helper in the frame says hello once the product's page loads.
  useEffect(() => {
    if (!origin) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; cookies?: boolean } | null;
      if (e.origin !== origin || data?.type !== "formic:hello") return;
      setHelloFrom(origin);
      if (data.cookies) setCookiesFrom(origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  /* ---------------------------------------------------- notes and asking */

  const askTimer = useRef<number | null>(null);
  const unasked = useRef(false);
  const ask = useCallback(async () => {
    if (askTimer.current) window.clearTimeout(askTimer.current);
    askTimer.current = null;
    if (!unasked.current || !sessionId) return;
    unasked.current = false;
    await fetch(`/api/playtest/${sessionId}/ask`, { method: "POST" }).catch(() => null);
    void refresh();
  }, [sessionId, refresh]);
  const askSoon = useCallback(() => {
    if (askTimer.current) window.clearTimeout(askTimer.current);
    if (!unasked.current) return;
    askTimer.current = window.setTimeout(() => void ask(), ASK_AFTER_MS);
  }, [ask]);
  // Notes not yet asked about are asked about on the way out.
  useEffect(() => () => void ask(), [ask]);

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || (!text.trim() && !shots.length)) return false;
      const res = await fetch(`/api/playtest/${sessionId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, shots: shots.map((s) => s.requestId) }),
      }).catch(() => null);
      if (!res?.ok) return false;
      const body = (await res.json()) as { message: PlaytestMessage };
      setMessages((m) => [...m, body.message]);
      setShots([]);
      unasked.current = true;
      askSoon();
      return true;
    },
    [sessionId, shots, askSoon],
  );

  const stopNow = async () => {
    await ask();
    await p.stop();
    void refresh();
  };
  const restart = async () => {
    await ask();
    setMessages([]);
    await p.start();
  };

  /* ---------------------------------------------------------- screenshots */

  const shotWanted = live && (helperReady || (desktop && canCaptureTab()));
  const takeShot = async (viewportRect: Rect) => {
    setSelecting(false);
    setShotError(null);
    if (!sessionId || viewportRect.w < 4 || viewportRect.h < 4) return;
    try {
      let blob: Blob;
      const box = frame.current?.getBoundingClientRect();
      if (helperReady && frame.current && origin && box) {
        blob = await captureInFrame(frame.current, origin, {
          x: viewportRect.x - box.left,
          y: viewportRect.y - box.top,
          w: viewportRect.w,
          h: viewportRect.h,
        });
      } else {
        blob = await captureTab(viewportRect);
      }
      const shot = await uploadShot(p.projectId, sessionId, blob);
      setShots((s) => [...s, shot].slice(0, 5));
      if (!desktop) setSheetOpen(true);
    } catch (e) {
      setShotError(e instanceof Error ? e.message : "The screenshot did not work.");
    }
  };

  /* ---------------------------------------------------------------- view */

  const shown = viewing ?? (session ? { session, messages } : null);
  const reading = !!viewing;

  const chat = (
    <NotesColumn
      messages={shown?.messages ?? []}
      readOnly={reading || !open}
      onBack={reading ? () => setViewing(null) : undefined}
      title={reading ? `Playtest, ${when(viewing!.session.startedAt)}` : "PM"}
      shots={shots}
      onRemoveShot={(id) => setShots((s) => s.filter((x) => x.id !== id))}
      onSend={send}
      onTyping={askSoon}
      onDecide={async (messageId, index, decision) => {
        await fetch("/api/assistant/proposals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId, index, decision }),
        }).catch(() => null);
        if (reading) {
          const res = await fetch(`/api/playtest/${viewing!.session.id}`).catch(() => null);
          const body = (await res?.json().catch(() => null)) as { session: PlaytestSession; messages: PlaytestMessage[] } | null;
          if (body) setViewing(body);
        } else void refresh();
      }}
    />
  );

  return (
    <div
      role="region"
      aria-label="Playtest"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 z-[60] flex flex-col md:top-16"
    >
      {live && <AutoTour id="playtest" delay={900} />}

      {/* Top bar */}
      <div className="border-line flex shrink-0 items-center gap-1.5 border-b px-3 py-2 md:gap-2 md:px-4">
        <div className="flex min-w-0 items-center gap-1.5 md:gap-2">
          {open && (
            <button type="button" onClick={() => void stopNow()} className={barButton} aria-label="Stop the playtest">
              <span aria-hidden className="bg-crimson size-2 rounded-sm" />
              <span className="hidden sm:inline">Stop</span>
            </button>
          )}
          {shotWanted && (
            <button
              type="button"
              data-tour="playtest-shot"
              onClick={() => setSelecting((s) => !s)}
              aria-pressed={selecting}
              className={cn(barButton, selecting && "border-clay text-ink")}
            >
              <ShotIcon />
              <span className="hidden sm:inline">Screenshot</span>
            </button>
          )}
          {session && (
            <button
              type="button"
              onClick={() => void restart()}
              className={cn(barButton, session.newer && open && "glow-ready border-jade text-ink")}
              title={session.newer ? "Newer work has merged: restart to play it" : "Start again from the default branch"}
            >
              <RestartIcon />
              <span className="hidden sm:inline">{open ? "Restart" : "Play again"}</span>
            </button>
          )}
          <span className="text-muted hidden truncate font-mono text-[10px] md:inline">
            {session?.commitSha ? session.commitSha.slice(0, 7) : p.repoName}
            {left !== null && ` · ${mmss(left)} left`}
          </span>
          {left !== null && <span className="text-muted font-mono text-[10px] md:hidden">{mmss(left)}</span>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 md:gap-2">
          <button
            type="button"
            data-tour="playtest-sessions"
            onClick={() => setSessionsOpen((s) => !s)}
            aria-expanded={sessionsOpen}
            className={barButton}
          >
            <ListIcon />
            <span className="hidden sm:inline">Sessions</span>
          </button>
          {live && (
            <a
              href={session!.url!}
              target="_blank"
              rel="noreferrer"
              title="Anyone with this link can open it while it runs."
              className={cn(barButton.replace("inline-flex", "hidden md:inline-flex"))}
            >
              Open in new tab ↗
            </a>
          )}
          <button type="button" onClick={p.close} aria-label="Close Playtest" className={cn(barButton, "px-2")}>
            ✕
          </button>
        </div>
      </div>

      {live && cookiesFrom === origin && !cookieHintClosed && (
        <div role="note" className="border-line bg-column text-muted flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[12px] md:px-4">
          <span className="min-w-0 flex-1">
            Signing in? Some browsers, Safari among them, don&apos;t keep a sign-in inside this frame.{" "}
            <a href={session!.url!} target="_blank" rel="noreferrer" className="text-ink underline">
              Open it in a new tab
            </a>{" "}
            if it doesn&apos;t stick.
          </span>
          <button type="button" onClick={() => setCookieHintClosed(true)} aria-label="Dismiss" className="hover:text-ink">
            ✕
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* The product */}
        <div data-tour="playtest-frame" className="relative min-w-0 flex-1">
          {live ? (
            <>
              <iframe
                ref={frame}
                key={session!.url}
                src={session!.url!}
                title={`${p.repoName}, playtest`}
                allow="autoplay; fullscreen; gamepad; clipboard-write; pointer-lock"
                className="absolute inset-0 h-full w-full border-0 bg-white"
              />
              <p className="text-muted bg-cream/90 pointer-events-none absolute top-2 left-2 m-0 rounded px-2 py-0.5 text-[10px] md:hidden">
                Anyone with this link can open it while it runs.
              </p>
            </>
          ) : (
            <FrameState session={session} startError={p.startError} onRetry={() => void restart()} onAskFix={send} />
          )}
          {selecting && <Selector onDone={(r) => void takeShot(r)} onCancel={() => setSelecting(false)} />}
          {shotError && (
            <div role="alert" className="bg-card border-line shadow-lift absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-lg border px-3 py-2 text-[12px]">
              {shotError}{" "}
              <button type="button" className="text-muted underline" onClick={() => setShotError(null)}>
                OK
              </button>
            </div>
          )}
        </div>

        {/* The PM */}
        {desktop ? (
          <aside data-tour="playtest-notes" className="border-line bg-card flex w-[340px] shrink-0 flex-col border-l">
            {chat}
          </aside>
        ) : (
          <>
            <button
              type="button"
              data-tour="playtest-notes"
              onClick={() => setSheetOpen(true)}
              className="bg-cta shadow-lift absolute right-3 bottom-3 z-10 inline-flex h-11 items-center gap-2 rounded-full px-4 text-[13px] font-semibold text-white"
            >
              Notes{messages.length ? ` · ${messages.length}` : ""}
            </button>
            {sheetOpen && (
              <div className="bg-card border-line absolute inset-x-0 bottom-0 z-20 flex h-[70%] flex-col rounded-t-2xl border-t shadow-lg">
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  aria-label="Back to the game"
                  className="mx-auto mt-2 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-[var(--line)]"
                />
                {chat}
              </div>
            )}
          </>
        )}

        {sessionsOpen && (
          <SessionsPanel
            currentId={session?.id ?? null}
            onClose={() => setSessionsOpen(false)}
            onOpen={async (id) => {
              setSessionsOpen(false);
              if (id === session?.id) return setViewing(null);
              const res = await fetch(`/api/playtest/${id}`).catch(() => null);
              const body = (await res?.json().catch(() => null)) as { session: PlaytestSession; messages: PlaytestMessage[] } | null;
              if (body) {
                setViewing(body);
                if (!desktop) setSheetOpen(true);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

const barButton =
  "border-line text-muted hover:text-ink hover:border-clay inline-flex h-9 items-center gap-1.5 rounded-lg border bg-[var(--card)] px-2.5 text-[12px] font-medium transition-colors md:h-8";

/* ------------------------------------------------------------- the frame */

function FrameState({
  session,
  startError,
  onRetry,
  onAskFix,
}: {
  session: PlaytestSession | null;
  startError: string | null;
  onRetry: () => void;
  onAskFix: (text: string) => Promise<boolean>;
}) {
  const [asked, setAsked] = useState(false);
  if (startError && !isOpen(session)) {
    return (
      <Centered>
        <p className="text-ink m-0 text-[13px]">{startError}</p>
        <button type="button" onClick={onRetry} className={cn(barButton, "mt-3")}>
          Try again
        </button>
      </Centered>
    );
  }
  if (!session) return <Centered><p className="text-muted m-0 text-[13px]">Getting ready…</p></Centered>;

  if (session.status === "starting") {
    const [stage, label] = (session.stage ?? "sandbox").split(":");
    const at = Math.max(0, STAGES.findIndex((s) => s.key === stage));
    return (
      <Centered>
        <p className="text-muted m-0 font-mono text-[10px] tracking-[0.12em] uppercase">Playtest{label ? ` · ${label}` : ""}</p>
        <ol className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
          {STAGES.map((s, i) => (
            <li key={s.key} className={cn("flex items-center gap-2 text-[13px]", i < at ? "text-muted" : i === at ? "text-ink font-medium" : "text-muted/60")}>
              <span aria-hidden className={cn("size-1.5 rounded-full", i < at ? "bg-jade" : i === at ? "bg-clay pulse-dot" : "bg-idle")} />
              {s.label}
              {i === at && "…"}
            </li>
          ))}
        </ol>
        <div aria-hidden className="ant-trail mt-4 w-48" />
        <Log lines={session.logTail} />
      </Centered>
    );
  }

  if (session.status === "failed") {
    // Only the project's own failures are a ticket's to fix: an install, an export, a server that never answers.
    const projects = session.endReason === "failed";
    return (
      <Centered>
        <p className="text-ink m-0 font-serif text-[18px] font-semibold">It did not start.</p>
        <p className="text-muted m-0 mt-1 text-[13px] whitespace-pre-line">{session.error}</p>
        {session.endReason === "needs-config" ? (
          <p className="text-muted m-0 mt-2 text-[12px]">
            An agent can&apos;t add your secrets, so there is nothing to hand it. Playtest can run this once the app starts without them, for example with a demo mode.
          </p>
        ) : (
          !projects && (
            <p className="text-muted m-0 mt-2 text-[12px]">This one is on Playtest&apos;s side, not your project&apos;s, so there is nothing for an agent to fix. Try again in a moment.</p>
          )
        )}
        <Log lines={session.logTail} />
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onRetry} className={barButton}>
            Try again
          </button>
          {projects && (
            <button
              type="button"
              disabled={asked}
              onClick={() =>
                void onAskFix(
                  `Playtest could not start the default branch. Please propose a ticket to fix it.\n\n${session.error ?? ""}\n\nThe last lines of the log:\n${session.logTail.slice(-15).join("\n")}`,
                ).then((ok) => setAsked(ok))
              }
              className="bg-cta inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-semibold text-white disabled:opacity-60"
            >
              {asked ? "Asked the PM" : "Ask an agent to fix it"}
            </button>
          )}
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <p className="text-ink m-0 font-serif text-[18px] font-semibold">{ENDED[session.endReason ?? ""] ?? "Ended"}</p>
      {session.summary && <p className="text-muted m-0 mt-1 text-[13px]">{session.summary}</p>}
      <button type="button" onClick={onRetry} className={cn(barButton, "mt-3")}>
        <PlayIcon /> Play again
      </button>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center px-6 text-center">{children}</div>;
}

function Log({ lines }: { lines: string[] }) {
  const end = useRef<HTMLPreElement>(null);
  useEffect(() => {
    end.current?.scrollTo?.({ top: end.current.scrollHeight });
  }, [lines]);
  if (!lines.length) return null;
  return (
    <pre
      ref={end}
      className="bg-card border-line text-muted mt-4 max-h-40 w-full max-w-[560px] overflow-auto rounded-lg border p-2 text-left font-mono text-[10px] leading-relaxed whitespace-pre-wrap"
    >
      {lines.slice(-12).join("\n")}
    </pre>
  );
}

/** Drag across the frame to pick a region, like a screenshot shortcut. Escape cancels. */
function Selector({ onDone, onCancel }: { onDone: (r: Rect) => void; onCancel: () => void }) {
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const [to, setTo] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCancel]);
  const r = from && to ? rectBetween(from, to) : null;
  return (
    <div
      role="application"
      aria-label="Drag across the part to capture. Escape cancels."
      className="absolute inset-0 z-10 cursor-crosshair touch-none bg-black/10"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setFrom({ x: e.clientX, y: e.clientY });
        setTo({ x: e.clientX, y: e.clientY });
      }}
      onPointerMove={(e) => from && setTo({ x: e.clientX, y: e.clientY })}
      onPointerUp={(e) => {
        if (!from) return;
        const rect = rectBetween(from, { x: e.clientX, y: e.clientY });
        setFrom(null);
        setTo(null);
        if (rect.w < 4 || rect.h < 4) return;
        onDone(rect);
      }}
    >
      {!r && (
        <p className="bg-card shadow-lift text-ink pointer-events-none absolute top-3 left-1/2 m-0 -translate-x-1/2 rounded-full px-3 py-1 text-[12px]">
          Drag across the part you mean
        </p>
      )}
      {r && (
        <div
          className="border-clay pointer-events-none fixed border-2 bg-white/10"
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- the PM column */

function NotesColumn({
  messages,
  readOnly,
  title,
  onBack,
  shots,
  onRemoveShot,
  onSend,
  onTyping,
  onDecide,
}: {
  messages: PlaytestMessage[];
  readOnly: boolean;
  title: string;
  onBack?: () => void;
  shots: PlaytestShot[];
  onRemoveShot: (id: string) => void;
  onSend: (text: string) => Promise<boolean>;
  onTyping: () => void;
  onDecide: (messageId: string, index: number, decision: "apply" | "dismiss") => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo?.({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const submit = async () => {
    if (sending) return;
    setSending(true);
    const ok = await onSend(text);
    setSending(false);
    if (ok) setText("");
  };
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <>
      <div className="border-line flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {onBack && (
          <button type="button" onClick={onBack} className="text-muted hover:text-ink text-[12px]" aria-label="Back to this playtest">
            ←
          </button>
        )}
        <span className="text-ink truncate text-[12px] font-semibold">{title}</span>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!messages.length && (
          <p className="text-muted m-0 text-[12px] leading-snug">
            {readOnly
              ? "No notes in this playtest."
              : "Play, and write a note when something looks off. I'll say whether it needs a ticket, is already known, or is meant to be that way."}
          </p>
        )}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {messages.map((m) => (
            <li key={m.id} className={cn("flex flex-col", m.role === "user" ? "items-end" : "items-start")}>
              <div
                className={cn(
                  "max-w-[92%] rounded-xl px-3 py-2 text-[13px] leading-snug",
                  m.role === "user" ? "bg-column text-ink" : "text-ink",
                  m.status === "failed" && "text-crimson",
                )}
              >
                {m.role === "user" && (
                  <span className="text-muted mb-0.5 block font-mono text-[10px] tracking-[0.1em] uppercase">Playtest note</span>
                )}
                {m.status === "pending" ? (
                  <span className="text-muted">Looking into it…</span>
                ) : m.content ? (
                  <MarkdownLite text={m.content} keepLineBreaks={m.role === "user"} />
                ) : null}
                {m.shots.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {m.shots.map((s) => (
                      <a key={s.id} href={s.url} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- an attachment, not a static asset */}
                        <img src={s.url} alt="Screenshot" className="border-line max-h-28 rounded-md border" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
              {m.proposals.map((proposal, i) => (
                <div key={i} className="mt-1.5 w-full">
                  <ProposalCard p={proposal} onDecide={(d) => onDecide(m.id, i, d)} />
                </div>
              ))}
            </li>
          ))}
        </ul>
      </div>
      {!readOnly && (
        <div className="border-line shrink-0 border-t p-2">
          {shots.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {shots.map((s) => (
                <span key={s.id} className="border-line relative inline-flex rounded-md border">
                  {/* eslint-disable-next-line @next/next/no-img-element -- an attachment, not a static asset */}
                  <img src={s.url} alt="Screenshot to send" className="h-12 rounded-md" />
                  <button
                    type="button"
                    onClick={() => onRemoveShot(s.id)}
                    aria-label="Remove this screenshot"
                    className="bg-card border-line absolute -top-1.5 -right-1.5 size-5 rounded-full border text-[10px]"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={text}
            rows={2}
            onChange={(e) => {
              setText(e.target.value);
              onTyping();
            }}
            onKeyDown={onKey}
            placeholder="Write a note…"
            aria-label="Write a note for the PM. Enter sends, Shift+Enter starts a new line."
            className="border-line bg-card text-ink focus:border-clay block w-full resize-none rounded-lg border px-2.5 py-2 text-[13px] outline-none"
          />
          <p className="text-muted m-0 mt-1 text-[10px]">Enter sends · Shift+Enter for a new line</p>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------ past sessions */

function SessionsPanel({
  currentId,
  onClose,
  onOpen,
}: {
  currentId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<PastSession[] | null>(null);
  useEffect(() => {
    void fetch("/api/playtest/sessions", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { sessions: PastSession[] }) => setSessions(b.sessions))
      .catch(() => setSessions([]));
  }, []);
  return (
    <div
      role="dialog"
      aria-label="Past playtests"
      className="bg-card border-line shadow-lift absolute top-2 right-2 z-30 flex max-h-[80%] w-[min(340px,calc(100%-16px))] flex-col rounded-xl border"
    >
      <div className="border-line flex items-center border-b px-3 py-2">
        <span className="text-ink text-[12px] font-semibold">Sessions</span>
        <button type="button" onClick={onClose} aria-label="Close sessions" className="text-muted hover:text-ink ml-auto text-[12px]">
          ✕
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto p-1">
        {sessions === null && <p className="text-muted m-0 p-2 text-[12px]">Loading…</p>}
        {sessions?.length === 0 && <p className="text-muted m-0 p-2 text-[12px]">No playtests yet.</p>}
        {sessions?.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpen(s.id)}
            className="hover:bg-column flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left"
          >
            <span className="text-ink text-[12px] font-medium">
              {when(s.startedAt)}
              {s.id === currentId && <span className="text-jade"> · now</span>}
            </span>
            <span className="text-muted text-[11px]">
              {s.mine ? "You" : s.by} · {s.commitSha?.slice(0, 7) ?? "no build"} · {s.notes} {s.notes === 1 ? "note" : "notes"}
              {s.status === "failed" ? " · did not start" : ""}
            </span>
            {s.summary && <span className="text-muted text-[11px]">{s.summary}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- icons */

function ShotIcon() {
  return (
    <svg aria-hidden width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.2" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M10 6a4 4 0 1 1-1.2-2.85" />
      <path d="M9.2 1.4v2h-2" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M2 3h8M2 6h8M2 9h5" />
    </svg>
  );
}
