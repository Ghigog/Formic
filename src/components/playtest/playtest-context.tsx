"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColony } from "@/components/colony/colony";
import { isOpen, type PlaytestAccess, type PlaytestSession } from "./types";

/**
 * Playtest on a board: whether this person can use it, the session they
 * have open, and whether its screen is up. See docs/plans/playtest.md.
 */
export interface PlaytestApi {
  /** Null while it is being read. */
  access: PlaytestAccess | null;
  session: PlaytestSession | null;
  screenOpen: boolean;
  /** Opens the screen: onto the running session, or starting one. */
  open: () => void;
  close: () => void;
  /** Starts a fresh session of the default branch: Restart, or a first start. */
  start: () => Promise<void>;
  stop: () => Promise<void>;
  setSession: (s: PlaytestSession | null) => void;
  startError: string | null;
  repoName: string;
  projectId: string;
}

const Ctx = createContext<PlaytestApi | null>(null);

export function usePlaytest(): PlaytestApi | null {
  return useContext(Ctx);
}

const PlaytestScreen = dynamic(() => import("./playtest-screen").then((m) => m.PlaytestScreen), {
  ssr: false,
  loading: () => (
    <div
      role="region"
      aria-label="Playtest"
      aria-busy="true"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 z-[60] px-4 pt-5 md:top-16 md:px-6"
    >
      <p className="text-muted m-0 text-[13px]">Loading…</p>
    </div>
  ),
});

export function PlaytestProvider({ repoName, projectId, children }: { repoName: string; projectId: string; children: ReactNode }) {
  const colony = useColony();
  const unlocked = colony?.featureUnlocked("playtest") ?? false;
  const [access, setAccess] = useState<PlaytestAccess | null>(null);
  const [session, setSession] = useState<PlaytestSession | null>(null);
  const [screenOpen, setScreenOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/playtest", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { access: PlaytestAccess; session: PlaytestSession | null };
      setAccess(body.access);
      setSession((now) => (isOpen(now) && !body.session ? now : body.session));
    } catch {
      // Offline: the button stays as it was.
    }
  }, []);

  // Read once unlocked, and again on return to the tab: a key added in Settings wakes the button.
  useEffect(() => {
    if (!unlocked) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a fetch: its answer arrives later
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [unlocked, refresh]);

  // A session keeps going while the board is open, screen up or not: the
  // screen polls quickly; this keeps it alive (and its button's clock right)
  // when the person steps back to the board. Closing the tab lets it end.
  const sessionId = isOpen(session) ? session!.id : null;
  useEffect(() => {
    if (!sessionId || screenOpen) return;
    const beat = async () => {
      const res = await fetch(`/api/playtest/${sessionId}`, { cache: "no-store" }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { session?: PlaytestSession } | null;
      if (body?.session) setSession(body.session);
    };
    const t = setInterval(() => void beat(), 20_000);
    return () => clearInterval(t);
  }, [sessionId, screenOpen]);

  const start = useCallback(async () => {
    setStartError(null);
    try {
      const res = await fetch("/api/playtest", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { session?: PlaytestSession; error?: string };
      if (!res.ok || !body.session) {
        setStartError(body.error ?? "Playtest could not start.");
        void refresh();
        return;
      }
      setSession(body.session);
    } catch {
      setStartError("Playtest could not start: no connection.");
    }
  }, [refresh]);

  const stop = useCallback(async () => {
    if (!session) return;
    const res = await fetch(`/api/playtest/${session.id}`, { method: "DELETE" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { session?: PlaytestSession } | null;
    if (body?.session) setSession(body.session);
  }, [session]);

  const open = useCallback(() => {
    setScreenOpen(true);
    colony?.setTimelineOpen(false);
    colony?.setSentinelsOpen(false);
    if (!isOpen(session)) void start();
  }, [colony, session, start]);

  const api = useMemo<PlaytestApi>(
    () => ({
      access,
      session,
      screenOpen,
      open,
      close: () => setScreenOpen(false),
      start,
      stop,
      setSession,
      startError,
      repoName,
      projectId,
    }),
    [access, session, screenOpen, open, start, stop, startError, repoName, projectId],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {screenOpen && <PlaytestScreen />}
    </Ctx.Provider>
  );
}
