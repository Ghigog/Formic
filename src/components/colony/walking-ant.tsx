"use client";

import { useEffect, useRef } from "react";
import { useColony } from "./colony";
import { drawBug } from "./fx";

/** A small bug whose legs cycle in place; one still frame under reduced motion. */
export function WalkingAnt() {
  const c = useColony();
  const ref = useRef<HTMLCanvasElement>(null);
  const shape = c?.shape ?? "ant";
  const hex = c?.bugHex;
  const reduced = c?.fx.reducedMotion ?? false;
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx || !hex) return;
    let raf = 0;
    const draw = (legSwing?: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      drawBug(ctx, cv.width / 2, cv.height / 2, 3.2, 0.26, shape, hex, undefined, legSwing === undefined ? undefined : { legSwing });
    };
    if (reduced) {
      draw();
    } else {
      const paint = (now: number) => {
        draw(Math.sin(now / 60) * 0.9);
        raf = requestAnimationFrame(paint);
      };
      raf = requestAnimationFrame(paint);
    }
    return () => cancelAnimationFrame(raf);
  }, [shape, hex, reduced]);
  return <canvas ref={ref} data-testid="scout-ant" width={40} height={40} className="size-[14px]" aria-hidden />;
}
