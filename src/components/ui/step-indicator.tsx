import { cn } from "./cn";
import { LIFECYCLE_STAGES, type StageState } from "@/lib/domain/stages";

/**
 * The 8-stage lifecycle stepper shown inside every Epic drawer:
 * Prompt -> PRD Draft -> DAG Breakdown -> Sandbox Mint -> Code Run ->
 * PR Opened -> Rebase & Merge -> Async Showcase.
 */
export function StepIndicator({
  current,
  failedAt,
  working = false,
  className,
}: {
  /** 1-8. Stages below this are complete, this one is active. */
  current: number;
  /** When set, this stage renders failed and nothing after it is active. */
  failedAt?: number | null;
  /**
   * An agent is on it right now. A trail of ants marches out of the active
   * stage toward the next, left to right.
   */
  working?: boolean;
  className?: string;
}) {
  function stateOf(n: number): StageState {
    if (failedAt != null && n === failedAt) return "failed";
    if (n < current) return "complete";
    if (n === current) return "active";
    return "pending";
  }

  return (
    <ol
      className={cn("flex w-full items-start gap-0", className)}
      aria-label="Epic lifecycle"
    >
      {LIFECYCLE_STAGES.map((stage, i) => {
        const state = stateOf(stage.n);
        const isLast = i === LIFECYCLE_STAGES.length - 1;
        // The line leaving the active stage; on the last stage, the one into it.
        const marching =
          working &&
          failedAt == null &&
          (stage.n === current ||
            (current === LIFECYCLE_STAGES.length && stage.n === current - 1));
        return (
          <li key={stage.key} className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-1">
              <span
                aria-hidden
                className={cn(
                  "clip-octagon grid size-5 shrink-0 place-items-center font-mono text-[10px] font-medium",
                  state === "complete" && "bg-jade text-on-jade",
                  state === "active" && "bg-ochre text-on-ochre",
                  state === "failed" && "bg-crimson text-on-crimson",
                  state === "pending" && "bg-sunken text-fg-subtle",
                )}
              >
                {stage.n}
              </span>
              {!isLast && (
                <span
                  aria-hidden
                  className={cn(
                    "flex-1",
                    marching
                      ? "ant-trail"
                      : cn("h-px", state === "complete" ? "bg-jade" : "bg-line"),
                  )}
                />
              )}
            </div>
            <span
              className={cn(
                "truncate text-[10px] leading-3",
                state === "pending" ? "text-fg-subtle" : "text-fg-muted",
                state === "active" && "text-ochre-text font-medium",
                state === "failed" && "text-crimson-text font-medium",
              )}
              title={stage.label}
            >
              {stage.label}
            </span>
            <span className="sr-only">
              {stage.label}: {state}
              {working && stage.n === current ? ", in progress" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
