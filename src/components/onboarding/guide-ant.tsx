import { cn } from "@/components/ui/cn";

/**
 * The colony's own ant (drawBug's "ant" in src/components/colony/fx.ts),
 * drawn as SVG so it can walk with CSS. Crimson, legs included: the app's
 * near-black legs would vanish on the tour's dark ground.
 *
 * The legs swing the same way drawBug swings them, the outer pair on one
 * side against the middle leg on the other (globals.css, "Guide ant").
 */
export const GUIDE_ANT_HEX = "#B3261E";

export function GuideAnt({
  walking = false,
  talking = false,
  size = 52,
  className,
}: {
  walking?: boolean;
  talking?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={(size * 16) / 13}
      viewBox="-6.5 -8 13 16"
      aria-hidden="true"
      data-testid="guide-ant"
      className={cn("guide-ant", walking && "guide-ant-walk", talking && "guide-ant-talk", className)}
    >
      <g className="guide-ant-bob">
        <g fill="none" stroke={GUIDE_ANT_HEX} strokeWidth="0.8" strokeLinecap="round">
          <path className="guide-ant-legs-a" d="M0 -1.2L-3.3 -2.6M0 1.2L-3.3 2.6M0 0L3.3 0" />
          <path className="guide-ant-legs-b" d="M0 -1.2L3.3 -2.6M0 1.2L3.3 2.6M0 0L-3.3 0" />
          <path className="guide-ant-antennae" d="M-0.5 -3L-2 -5.2M0.5 -3L2 -5.2" />
        </g>
        <g fill={GUIDE_ANT_HEX}>
          <ellipse cx="0" cy="3.3" rx="1.6" ry="2.3" />
          <ellipse cx="0" cy="0.2" rx="0.95" ry="1.3" />
          <ellipse cx="0" cy="-2.3" rx="1.15" ry="1.25" />
        </g>
      </g>
    </svg>
  );
}
