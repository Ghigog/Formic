"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { whenHeard } from "@/components/onboarding/voice";
import { useColony } from "./colony";

/** How long each phase runs: the header clears a space, then the button rises. */
export const SPACE_MS = 220;
export const RISE_MS = 460;
/** Under reduced motion: no space, and the button only fades in. */
export const FADE_MS = 150;

type Phase = "space" | "rise" | "settled";

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A feature's button arriving on the header. With `reveal` off it is just the
 * button. With it on: the header clears a space, the button rises inside a clay
 * ring, a burst and a short glow, and the celebration cue sounds as it rises.
 * Reduced motion fades it in with no movement; the cue still plays. `onSettled`
 * fires once when it is all done, which is when the guide ant's tour can begin.
 */
export function FeatureReveal({
  reveal,
  onSettled,
  children,
}: {
  reveal: boolean;
  onSettled?: () => void;
  children: ReactNode;
}) {
  const sfx = useColony()?.sfx;
  const [phase, setPhase] = useState<Phase>(reveal ? "space" : "settled");
  const settled = useRef(onSettled);
  const cue = useRef(sfx);
  useEffect(() => {
    settled.current = onSettled;
    cue.current = sfx;
  });

  useEffect(() => {
    if (!reveal) return;
    const reduced = reducedMotion();
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Reduced motion still gives the button a moment at opacity 0, so it fades.
    timers.push(
      setTimeout(
        () => {
          setPhase("rise");
          whenHeard(() => cue.current?.("celebrate"));
          timers.push(
            setTimeout(
              () => {
                setPhase("settled");
                settled.current?.();
              },
              reduced ? FADE_MS : RISE_MS,
            ),
          );
        },
        reduced ? 16 : SPACE_MS,
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [reveal]);

  if (phase === "settled")
    return <div className={reveal ? "feature-reveal" : "contents"} data-phase="settled">{children}</div>;

  return (
    <div className="feature-reveal" data-phase={phase}>
      <div className="feature-reveal-stage">
        <span aria-hidden className="feature-reveal-fx feature-reveal-glow" />
        <span aria-hidden className="feature-reveal-fx feature-reveal-ring" />
        <span aria-hidden className="feature-reveal-fx feature-reveal-burst" />
        <div className="feature-reveal-item">{children}</div>
      </div>
    </div>
  );
}
