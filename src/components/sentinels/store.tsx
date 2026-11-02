"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { gradeOf, type GradeSummary } from "@/lib/sentinels/grade";
import { SENTINELS, isUnlocked } from "@/lib/sentinels/roster";
import { starsOf, type SentinelStates } from "@/lib/sentinels/view";
import type { AuditKind } from "@/lib/db/repository";

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
  /** Whether the project unlocked every Sentinel whatever the level. */
  unlockAll: boolean;
  /**
   * Summons one sentinel: to calibrate, writing its rubric, or to audit
   * against that rubric. A second summon while it runs does nothing.
   */
  summon: (id: string, kind?: AuditKind) => Promise<void>;
  /** Audits every unlocked sentinel, calibrating the ones that have no rubric yet. */
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
  unlockAll = false,
  children,
}: {
  initial: SentinelStates;
  level: number;
  unlockAll?: boolean;
  children: React.ReactNode;
}) {
  const [states, setStates] = useState(initial);
  const [refusal, setRefusal] = useState<string | null>(null);
  const grade = useMemo(() => gradeOf(starsOf(states), level, unlockAll), [states, level, unlockAll]);
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

  const summon = useCallback(async (id: string, kind: AuditKind = "audit") => {
    setRefusal(null);
    // Shown running at once; the server's answer fills in the real log.
    setStates((prev) => {
      const s = prev[id];
      if (!s || s.running) return prev;
      return { ...prev, [id]: { ...s, error: null, running: { kind, log: [], startedAt: new Date().toISOString() } } };
    });
    const res = await fetch(`/api/sentinels/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    }).catch(() => null);
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
    SENTINELS.filter((s) => isUnlocked(s, level, unlockAll)).forEach((s, i) => {
      const st = latest.current[s.id];
      if (st?.running) return;
      setTimeout(() => void summon(s.id, st?.rubric ? "audit" : "calibrate"), i * 240);
    });
  }, [summon, level, unlockAll]);

  const api = useMemo<SentinelsApi>(
    () => ({ states, grade, level, unlockAll, summon, summonAll, refusal }),
    [states, grade, level, unlockAll, summon, summonAll, refusal],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
