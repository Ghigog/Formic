"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";

/** Which way the swap goes: "down" moves to the board below, "up" to the one above. */
export type DigDirection = "down" | "up";

export type DigPhase =
  | { name: "idle" }
  | { name: "leaving"; direction: DigDirection }
  | { name: "digging"; direction: DigDirection }
  | { name: "entering"; direction: DigDirection }
  | { name: "bouncing"; direction: DigDirection };

export type DigTransitionHandle = {
  /** Slides the board off, digs until `load` settles, then brings the board in; a rejected `load` brings the old board back. */
  swap: (direction: DigDirection, load: Promise<unknown>) => Promise<void>;
  /** Bounces the board briefly when no board lies in that direction. */
  bounce: (direction: DigDirection) => void;
};

const LEAVE_MS = 300;
const ENTER_MS = 300;
const BOUNCE_MS = 400;
const FADE_MS = 200;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const DigTransition = forwardRef<DigTransitionHandle, { children: ReactNode }>(function DigTransition({ children }, ref) {
  const [phase, setPhase] = useState<DigPhase>({ name: "idle" });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busy = useRef(false);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const wait = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        timers.current.push(setTimeout(resolve, ms));
      }),
    [],
  );

  const swap = useCallback(
    async (direction: DigDirection, load: Promise<unknown>) => {
      if (busy.current) return;
      busy.current = true;
      const reduced = prefersReducedMotion();
      try {
        const loaded = load.then(() => true, () => false);
        setPhase({ name: "leaving", direction });
        await wait(reduced ? FADE_MS : LEAVE_MS);
        setPhase({ name: "digging", direction });
        if (!(await loaded)) {
          setPhase({ name: "idle" });
          return;
        }
        setPhase({ name: "entering", direction });
        await wait(reduced ? FADE_MS : ENTER_MS);
        setPhase({ name: "idle" });
      } finally {
        busy.current = false;
      }
    },
    [wait],
  );

  const bounce = useCallback(
    (direction: DigDirection) => {
      if (busy.current) return;
      busy.current = true;
      setPhase({ name: "bouncing", direction });
      void wait(BOUNCE_MS).then(() => {
        setPhase({ name: "idle" });
        busy.current = false;
      });
    },
    [wait],
  );

  useImperativeHandle(ref, () => ({ swap, bounce }), [swap, bounce]);

  const direction = phase.name === "idle" ? undefined : phase.direction;
  const showBand = phase.name === "digging" || phase.name === "leaving";

  return (
    <div className="relative overflow-hidden" data-testid="dig-transition" data-phase={phase.name}>
      {showBand && !prefersReducedMotion() ? <div className="dig-band absolute inset-0" data-testid="dig-band" aria-hidden="true" /> : null}
      <div className="dig-board relative" data-phase={phase.name} data-direction={direction}>
        {children}
      </div>
    </div>
  );
});
