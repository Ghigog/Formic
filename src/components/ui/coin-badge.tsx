import { cn } from "./cn";
import { TONES, type ToneName } from "@/lib/tokens";

/**
 * The 8-motif. All ticket metadata (size, model tag, complexity weight) is
 * framed in an octagon rather than a rounded pill, per the design spec.
 *
 * Implemented as a clipped outer element with a 1px inset ring rather than a
 * CSS border: `clip-path` cuts a border off at the diagonals, so the 1px
 * #E7E5E4 edge the spec asks for has to be drawn inside the clip.
 */
export function CoinBadge({
  children,
  tone = "neutral",
  filled = false,
  title,
  className,
}: {
  children: React.ReactNode;
  tone?: ToneName;
  filled?: boolean;
  title?: string;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      title={title}
      className={cn(
        "clip-octagon relative inline-flex min-w-8 items-center justify-center px-1.5 py-0.5",
        "font-mono text-[10px] leading-4 font-medium tracking-tight whitespace-nowrap",
        filled ? cn(t.fill, t.onFill) : cn("bg-surface", t.text),
        className,
      )}
    >
      {!filled && (
        <span
          aria-hidden
          className="clip-octagon pointer-events-none absolute inset-0 bg-line"
        >
          <span className="clip-octagon absolute inset-px bg-surface" />
        </span>
      )}
      <span className="relative">{children}</span>
    </span>
  );
}
