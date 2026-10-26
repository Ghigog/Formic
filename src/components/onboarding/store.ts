"use client";

import { useSyncExternalStore } from "react";
import type { TourId } from "./tours";

/**
 * Which tours this browser has seen, which one is running, and whether the
 * ant may talk. Kept in localStorage: a tour is a per-person nicety, and
 * losing the record only means seeing a tour again.
 */

const SEEN_KEY = "formic:tours:seen";
const VOICE_KEY = "formic:tours:voice";

const listeners = new Set<() => void>();
let active: TourId | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function readSeen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<string>) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // Private windows and full disks: the tour may show again. No harm done.
  }
}

export function hasSeen(id: TourId): boolean {
  return readSeen().has(id);
}

export function markSeen(id: TourId) {
  const seen = readSeen();
  seen.add(id);
  writeSeen(seen);
}

/** Forget every tour, so each screen's plays again the next time it opens. */
export function forgetTours() {
  writeSeen(new Set());
}

/**
 * From the account menu: forget every tour and, on the board, start its tour
 * again. Elsewhere it returns false, and the board's tour plays when the
 * board next opens. Each screen's own tour plays the next time it opens.
 */
export function replayTours(): boolean {
  forgetTours();
  if (!document.querySelector('[data-tour~="column"]')) return false;
  startTour("board");
  return true;
}

export function activeTour(): TourId | null {
  return active;
}

/**
 * Starts a tour now, replacing whichever was running. It counts as seen from
 * the start: the login and picker tours end with the page going away.
 */
export function startTour(id: TourId) {
  active = id;
  markSeen(id);
  emit();
}

/** Starts a tour unless it was seen before or another is running. */
export function offerTour(id: TourId): boolean {
  if (active !== null || hasSeen(id)) return false;
  startTour(id);
  return true;
}

export function endTour() {
  active = null;
  emit();
}

export function useActiveTour(): TourId | null {
  return useSyncExternalStore(subscribe, activeTour, () => null);
}

function readVoice(): boolean {
  try {
    return window.localStorage.getItem(VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Whether the ant mutters as it talks. Separate from the app's Sound switch, which also silences it. */
export function useAntVoice(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, readVoice, () => true);
  const set = (next: boolean) => {
    try {
      window.localStorage.setItem(VOICE_KEY, next ? "on" : "off");
    } catch {
      // The choice lasts until reload at most.
    }
    emit();
  };
  return [on, set];
}
