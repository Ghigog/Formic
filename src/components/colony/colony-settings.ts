"use client";

import { useCallback, useEffect, useState } from "react";

/** The colony as /api/colony answers it. */
export interface ColonyView {
  colonySize: number | null;
  colonyReserve: number;
  autoScout: boolean;
  level: number;
  floor: number;
  nextFloorLevel: number | null;
  maxScouts: number;
  autoScoutLevel: number;
  maxColony: number;
  inUse: number;
}

let cached: ColonyView | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<(v: ColonyView) => void>();

function share(view: ColonyView) {
  cached = view;
  for (const l of listeners) l(view);
}

/**
 * The board's colony settings, shared by every component that shows them and
 * fetched again when `refreshKey` changes (a new level, a move on the board).
 */
export function useColonySettings(refreshKey: unknown = null) {
  const [view, setView] = useState<ColonyView | null>(cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listeners.add(setView);
    return () => {
      listeners.delete(setView);
    };
  }, []);

  useEffect(() => {
    // A component that only reads the settings shares one fetch with the rest.
    if (refreshKey === null && (cached || inflight)) return;
    if (typeof fetch !== "function") return;
    inflight = fetch("/api/colony")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: ColonyView | null) => {
        if (body) share(body);
      })
      .catch(() => {})
      .finally(() => {
        inflight = null;
      });
  }, [refreshKey]);

  const save = useCallback(async (next: Pick<ColonyView, "colonySize" | "colonyReserve" | "autoScout">) => {
    try {
      const res = await fetch("/api/colony", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await res.json().catch(() => ({}))) as ColonyView & { error?: string };
      if (!res.ok) return setError(body.error ?? "Could not save the colony.");
      setError(null);
      share(body);
    } catch {
      setError("Could not save the colony.");
    }
  }, []);

  return { view, error, save };
}
