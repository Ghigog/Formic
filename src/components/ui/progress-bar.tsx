import { cn } from "./cn";

/**
 * A flat progress track: no radius beyond half its height, no percentage
 * label of its own. The caption underneath carries the meaning ("Running
 * vitest · 13/21 files"), which is why the bar itself stays quiet.
 */
export function ProgressBar({
  value,
  label,
  caption,
  height = 4,
  track = "bg-track",
  fill = "bg-clay",
  className,
}: {
  /** 0..1. Null renders an indeterminate bar. */
  value: number | null;
  /** Accessible name. Required: the bar has no visible label of its own. */
  label: string;
  /** Mono caption rendered under the bar, as on a running card. */
  caption?: string;
  height?: 4 | 6;
  track?: string;
  fill?: string;
  className?: string;
}) {
  const pct =
    value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);

  return (
    <div className={cn("flex flex-col gap-[5px]", className)}>
      <span
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className={cn("block overflow-hidden", track)}
        style={{ height, borderRadius: height / 2 }}
      >
        {/*
          Indeterminate draws a short, dimmed fill rather than a travelling
          bar: the motion budget is two loops, and neither is this one.
        */}
        <span
          className={cn(
            "block transition-[width] duration-500",
            fill,
            pct == null && "opacity-50",
          )}
          style={{ width: `${pct ?? 33}%`, height }}
        />
      </span>
      {caption && (
        <span className="text-muted font-mono text-[10px]">{caption}</span>
      )}
    </div>
  );
}
