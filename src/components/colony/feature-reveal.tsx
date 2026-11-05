"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SoundEngine } from "./sound";

/** Phase lengths, in ms; they match the keyframes in globals.css. */
export const REVEAL_SPACE_MS = 220;
export const REVEAL_RISE_MS = 460;
export const REVEAL_FADE_MS = 150;

type Phase = "idle" | "space" | "rise" | "fade" | "done";

/**
 * Wraps a header button that has just been unlocked. While `reveal` is on, the
 * header clears a space, then the button rises with a clay ring, a burst and a
 * short glow, and the celebration cue plays once. Under reduced motion it only
 * fades in; the cue still plays. `onSettled` fires once when it is over.
 */
export function FeatureReveal({
  reveal,
  sound,
  onSettled,
  children,
}: {
  reveal: boolean;
  sound: SoundEngine;
  onSettled?: () => void;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });
  const started = useRef(false);

  useEffect(() => {
    if (!reveal || started.current) return;
    started.current = true;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    /* eslint-disable react-hooks/set-state-in-effect -- the reveal is driven by timers started here */
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (after: number) =>
      timers.push(
        setTimeout(() => {
          setPhase("done");
          settled.current?.();
        }, after),
      );
    const cue = () => sound.whenAudible(() => sound.play("celebrate"));
    if (reduced) {
      setPhase("fade");
      cue();
      finish(REVEAL_FADE_MS);
    } else {
      setPhase("space");
      timers.push(
        setTimeout(() => {
          setPhase("rise");
          cue();
        }, REVEAL_SPACE_MS),
      );
      finish(REVEAL_SPACE_MS + REVEAL_RISE_MS);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      timers.forEach(clearTimeout);
      // Strict mode remounts effects: allow the run to start over.
      started.current = false;
    };
  }, [reveal, sound]);

  if (phase === "idle" && !reveal) return <>{children}</>;
  return (
    <span
      className="feature-reveal"
      data-phase={phase === "idle" ? "space" : phase}
    >
      <span className="feature-reveal-body inline-flex">{children}</span>
      <span className="feature-reveal-ring" aria-hidden="true" />
      <span className="feature-reveal-burst" aria-hidden="true" />
    </span>
  );
}
