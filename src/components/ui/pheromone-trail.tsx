"use client";

import { cn } from "./cn";

export interface TrailPoint {
  x: number;
  y: number;
}

/**
 * Pheromone dependency trails: curved connectors between a blocking ticket and
 * the tickets it holds. Clay Ochre, subtle until hovered, pulsing once when a
 * parent completes and releases its children.
 *
 * Rendered as an absolutely positioned SVG overlay so the trails do not affect
 * the accordion's layout. Coordinates come from the parent, which measures the
 * card anchors.
 */
export function PheromoneTrail({
  from,
  to,
  active = false,
  pulsing = false,
  className,
}: {
  from: TrailPoint;
  to: TrailPoint;
  /** Hover state on either endpoint. */
  active?: boolean;
  /** One-shot pulse when the dependency clears. */
  pulsing?: boolean;
  className?: string;
}) {
  // Horizontal control points give the lazy S-curve an ant trail has, rather
  // than the taut arc of a bezier with vertical handles.
  const dx = Math.max(24, Math.abs(to.x - from.x) * 0.6);
  const d = `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;

  return (
    <path
      d={d}
      fill="none"
      stroke="var(--formic-ochre)"
      strokeWidth={active ? 2 : 1.5}
      strokeOpacity={active ? 0.9 : 0.35}
      strokeLinecap="round"
      className={cn(
        "transition-[stroke-opacity,stroke-width] duration-200",
        pulsing && "animate-trail-pulse",
        className,
      )}
    />
  );
}

/** Overlay host. Sized by the caller; children are PheromoneTrail elements. */
export function TrailLayer({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="pointer-events-none absolute inset-0 overflow-visible"
    >
      {children}
    </svg>
  );
}
