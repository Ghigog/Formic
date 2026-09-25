"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { BugColor, BugShape } from "@/lib/colony/game";

/**
 * What the colony keeps in the browser, per board: the bug style and the
 * sound switch. Preferences only; the score and the heat come from the board.
 */
export interface Saved {
  shape: BugShape;
  color: BugColor;
  sound: boolean;
}

export const DEFAULTS: Saved = { shape: "ant", color: "umber", sound: true };

const listeners = new Set<() => void>();
let cache: { key: string; value: Saved } | null = null;

function read(key: string): Saved {
  if (cache?.key === key) return cache.value;
  let value = DEFAULTS;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) value = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Saved>) };
  } catch {
    // Unreadable or blocked storage: start fresh.
  }
  cache = { key, value };
  return value;
}

function write(key: string, value: Saved) {
  cache = { key, value };
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full disks: the colony just forgets on reload.
  }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab on the same board.
  const onStorage = () => {
    cache = null;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSaved(key: string): [Saved, (update: (s: Saved) => Saved) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => DEFAULTS,
  );
  const update = useCallback((f: (s: Saved) => Saved) => write(key, f(read(key))), [key]);
  return [value, update];
}

const noop = () => () => {};

/** False during SSR and hydration, true once the client has taken over. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
