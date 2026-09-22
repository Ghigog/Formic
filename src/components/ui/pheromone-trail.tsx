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
      stroke="var(--clay)"
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

/**
 * The board-column variant: a fixed-geometry trail drawn in the 22px gutter
 * left of an epic's child tickets.
 *
 * Fixed rather than measured because the rows are a known height (60px in a
 * board column, 92px in the drawer) precisely so the curve endpoints land on
 * a row's vertical centre without a layout pass. A spine runs the height of
 * the group at 22% opacity; one quadratic branch per child leaves it at 45%,
 * or in jade when the dependency has already unlocked.
 */
const ROW = 60;
const GAP = 8;
const STEP = ROW + GAP;

export function ColumnTrail({
  /** One entry per child row, in render order. True once it is unblocked. */
  unlocked,
}: {
  unlocked: boolean[];
}) {
  const n = unlocked.length;
  if (n === 0) return null;

  const height = n * ROW + (n - 1) * GAP;
  const spine = STEP * (n - 1) + ROW / 2 + 6;

  return (
    <svg
      width={22}
      height={height}
      viewBox={`0 0 22 ${height}`}
      fill="none"
      aria-hidden
      className="pointer-events-none absolute top-3 left-[10px]"
    >
      <path
        d={`M6 0 V${spine}`}
        stroke="var(--clay)"
        strokeOpacity={0.22}
        strokeWidth={1.5}
      />
      {unlocked.map((open, i) => {
        const start = STEP * i + 14;
        const end = STEP * i + ROW / 2;
        return (
          <path
            key={i}
            d={`M6 ${start} Q6 ${end} 22 ${end}`}
            fill="none"
            strokeWidth={1.5}
            stroke={open ? "var(--jade)" : "var(--clay)"}
            strokeOpacity={open ? 1 : 0.45}
            className={open ? "pulse-trail" : undefined}
          />
        );
      })}
    </svg>
  );
}
