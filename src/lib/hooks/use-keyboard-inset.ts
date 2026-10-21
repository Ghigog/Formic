"use client";

import { useEffect, useState } from "react";

export interface KeyboardInset {
  /** Pixels at the bottom of the layout viewport covered by the on-screen keyboard. */
  inset: number;
  /** Height of the visible area, or null while the keyboard is closed. */
  visibleHeight: number | null;
}

const CLOSED: KeyboardInset = { inset: 0, visibleHeight: null };

function measure(): KeyboardInset {
  const vv = window.visualViewport;
  if (!vv) return CLOSED;
  const inset = Math.max(
    0,
    Math.round(window.innerHeight - vv.height - vv.offsetTop),
  );
  return inset > 0 ? { inset, visibleHeight: Math.round(vv.height) } : CLOSED;
}

/**
 * Tracks the on-screen keyboard through window.visualViewport. Stays closed
 * (0, null) on desktop and where visualViewport is missing.
 */
export function useKeyboardInset(): KeyboardInset {
  const [state, setState] = useState<KeyboardInset>(CLOSED);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setState((prev) => {
        const next = measure();
        return next.inset === prev.inset &&
          next.visibleHeight === prev.visibleHeight
          ? prev
          : next;
      });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // Keep the focused input in view once the drawer has moved.
  useEffect(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.matches("input, textarea")) {
      el.scrollIntoView?.({ block: "nearest" });
    }
  }, [state.inset]);

  return state;
}

/**
 * Style for a drawer's backdrop and panel so both stay above the keyboard.
 * `open` tells the drawer to collapse its header extras (notice, progress,
 * epic link) so the content below keeps the height.
 */
export function keyboardStyles({ inset, visibleHeight }: KeyboardInset) {
  return {
    open: visibleHeight !== null,
    backdrop: inset > 0 ? { paddingBottom: inset } : undefined,
    panel: visibleHeight !== null ? { maxHeight: visibleHeight } : undefined,
  };
}
