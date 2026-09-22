import { cn } from "./cn";
import { TONES, type ToneName } from "@/lib/tokens";

export function ProgressBar({
  value,
  tone = "amber",
  label,
  className,
}: {
  /** 0..1. Null renders an indeterminate bar. */
  value: number | null;
  tone?: ToneName;
  label?: string;
  className?: string;
}) {
  const t = TONES[tone];
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <div
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="bg-sunken relative h-1 flex-1 overflow-hidden rounded-full"
      >
        {pct == null ? (
          <div className={cn("absolute inset-y-0 w-1/3 animate-pulse rounded-full", t.fill)} />
        ) : (
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", t.fill)}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {pct != null && (
        <span className="text-fg-subtle font-mono text-[10px] tabular-nums">
          {pct}%
        </span>
      )}
    </div>
  );
}
