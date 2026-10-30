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
  /**
   * Slides the board off into the earth, digs until `load` settles, hands its
   * value to `arrive` while the board is out of sight, then brings the new
   * board in. A rejected `load` brings the old board back instead.
   */
  swap: <T>(direction: DigDirection, load: Promise<T>, arrive: (value: T) => void, toward?: string) => Promise<boolean>;
  /** Bounces the board against the soil when no board lies in that direction. */
  bounce: (direction: DigDirection) => void;
  /** Follows a gesture still in progress by `px` (negative is up), or lets go with null. */
  pull: (px: number | null) => void;
};

export const LEAVE_MS = 320;
export const ENTER_MS = 460;
const BOUNCE_MS = 420;
const FADE_MS = 200;
/** The least time spent in the earth, so a board that loads at once still feels travelled to. */
export const MIN_DIG_MS = 420;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Moving between boards as moving through the colony's earth. The board slides
 * away in the direction of travel and the soil follows it in, scrolling past
 * (pebbles, roots, the odd ant) while the next board loads; the loaded board
 * then rises out of the soil and settles. A gesture in progress pulls the
 * board a little, with resistance, so the earth shows at its edge before it
 * lets go. Reduced motion is a crossfade, with no slide and no soil.
 */
/** The sounds a swap makes, as it makes them. */
export type DigSound = "dig" | "grit" | "surface" | "drop";

/** How often grit trickles past while the board loads. */
const GRIT_MS = 170;

export const DigTransition = forwardRef<DigTransitionHandle, { children: ReactNode; onSound?: (s: DigSound) => void }>(function DigTransition(
  { children, onSound },
  ref,
) {
  const [phase, setPhase] = useState<DigPhase>({ name: "idle" });
  const [pulled, setPulled] = useState<number | null>(null);
  const [toward, setToward] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busy = useRef(false);
  const lastPull = useRef(0);

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
    async <T,>(direction: DigDirection, load: Promise<T>, arrive: (value: T) => void, name?: string) => {
      if (busy.current) return false;
      busy.current = true;
      const reduced = prefersReducedMotion();
      setPulled(null);
      setToward(name ?? null);
      try {
        const loaded = load.then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        );
        setPhase({ name: "leaving", direction });
        onSound?.("dig");
        await wait(reduced ? FADE_MS : LEAVE_MS);
        setPhase({ name: "digging", direction });
        const grit = setInterval(() => onSound?.("grit"), GRIT_MS);
        const [result] = await Promise.all([loaded, reduced ? null : wait(MIN_DIG_MS)]).finally(() => clearInterval(grit));
        if (!result.ok) {
          // Back the way it came: the old board rises out of the soil again.
          setPhase({ name: "entering", direction: direction === "down" ? "up" : "down" });
          onSound?.("surface");
          await wait(reduced ? FADE_MS : ENTER_MS);
          setPhase({ name: "idle" });
          return false;
        }
        arrive(result.value);
        setPhase({ name: "entering", direction });
        onSound?.("surface");
        await wait(reduced ? FADE_MS : ENTER_MS);
        setPhase({ name: "idle" });
        return true;
      } finally {
        busy.current = false;
        lastPull.current = 0;
      }
    },
    [wait, onSound],
  );

  const bounce = useCallback(
    (direction: DigDirection) => {
      if (busy.current) return;
      busy.current = true;
      setPulled(null);
      setPhase({ name: "bouncing", direction });
      onSound?.("drop");
      void wait(BOUNCE_MS).then(() => {
        setPhase({ name: "idle" });
        busy.current = false;
      });
    },
    [wait, onSound],
  );

  const pull = useCallback((px: number | null) => {
    if (busy.current) return;
    if (px !== null) lastPull.current = px;
    setPulled(px === null || px === 0 ? null : px);
  }, []);

  useImperativeHandle(ref, () => ({ swap, bounce, pull }), [swap, bounce, pull]);

  const reduced = prefersReducedMotion();
  const moving = phase.name !== "idle";
  const direction = moving ? phase.direction : pulled !== null ? (pulled < 0 ? "down" : "up") : undefined;
  const showEarth = !reduced && (pulled !== null || moving);
  const style = {
    "--dig-pull": `${pulled ?? lastPull.current}px`,
  } as React.CSSProperties;

  return (
    <div
      className="dig-stage"
      data-testid="dig-transition"
      data-phase={phase.name}
      data-direction={direction}
      data-pulling={pulled !== null ? "" : undefined}
      style={style}
    >
      <div className="dig-board">{children}</div>
      {showEarth && (
        <div className="dig-earth" data-testid="dig-band" aria-hidden="true">
          <div className="dig-earth-far" />
          <div className="dig-earth-near" />
          <div className="dig-earth-tunnel" />
          {phase.name === "digging" && toward && (
            <p className="dig-toward">
              <span className="dig-toward-kicker">Digging to</span>
              <span className="dig-toward-name">{toward}</span>
            </p>
          )}
        </div>
      )}
      <p role="status" className="sr-only">
        {phase.name === "digging" ? `Loading ${toward ?? "the next board"}` : ""}
      </p>
    </div>
  );
});
