"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { gradeOf, type GradeSummary } from "@/lib/sentinels/grade";
import { SENTINELS } from "@/lib/sentinels/roster";
import { starsOf, type SentinelStates } from "@/lib/sentinels/view";

/**
 * The Sentinels' state on the client: each one's last report and any run in
 * progress, followed by polling while something runs. Polling rather than
 * the event stream, because the audit is journalled and a run may be on
 * another server instance than the stream.
 */

export interface SentinelsApi {
  states: SentinelStates;
  grade: GradeSummary;
  /** The colony level that decides which Sentinels are unlocked. */
  level: number;
  /** Summons one sentinel. A second summon while it runs does nothing. */
  summon: (id: string) => Promise<void>;
  summonAll: () => void;
  /** Why the last summon was refused, if it was. */
  refusal: string | null;
}

const Ctx = createContext<SentinelsApi | null>(null);

export function useSentinels(): SentinelsApi | null {
  return useContext(Ctx);
}

const POLL_MS = 5_000;

export function SentinelsProvider({
  initial,
  level,
  children,
}: {
  initial: SentinelStates;
  level: number;
  children: React.ReactNode;
}) {
  const [states, setStates] = useState(initial);
  const [refusal, setRefusal] = useState<string | null>(null);
  const grade = useMemo(() => gradeOf(starsOf(states), level), [states, level]);
  const anyRunning = Object.values(states).some((s) => s.running);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/sentinels", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json()) as { sentinels: SentinelStates };
    setStates(body.sentinels);
  }, []);

  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, refresh]);

  const summon = useCallback(async (id: string) => {
    setRefusal(null);
    // Shown running at once; the server's answer fills in the real log.
    setStates((prev) => {
      const s = prev[id];
      if (!s || s.running) return prev;
      return { ...prev, [id]: { ...s, error: null, running: { log: [], startedAt: new Date().toISOString() } } };
    });
    const res = await fetch(`/api/sentinels/${id}`, { method: "POST" }).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as { sentinels: SentinelStates };
      setStates(body.sentinels);
      return;
    }
    const body = res ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
    setRefusal(body?.error ?? "Could not reach the server.");
    void refresh();
  }, [refresh]);

  const latest = useRef(states);
  useEffect(() => {
    latest.current = states;
  }, [states]);
  const summonAll = useCallback(() => {
    SENTINELS.filter((s) => s.unlockLevel <= level).forEach((s, i) => {
      if (latest.current[s.id]?.running) return;
      setTimeout(() => void summon(s.id), i * 240);
    });
  }, [summon, level]);

  const api = useMemo<SentinelsApi>(
    () => ({ states, grade, level, summon, summonAll, refusal }),
    [states, grade, level, summon, summonAll, refusal],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
