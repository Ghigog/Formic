import { cn } from "./cn";
import type { PlanStep } from "@/lib/domain/entities";
import { currentStep } from "@/lib/agents/plan";

/**
 * The plan an agent is working a ticket through, top to bottom, in the
 * lifecycle stepper's language: jade when done, ochre where it is now, and
 * while the agent works, a trail of ants marching down from the current
 * step to the next.
 */
export function PlanSteps({
  steps,
  working = false,
  className,
}: {
  steps: readonly PlanStep[];
  /** An agent is on the ticket right now. */
  working?: boolean;
  className?: string;
}) {
  const now = currentStep(steps);
  return (
    <ol aria-label="Agent's plan" className={cn("flex flex-col", className)}>
      {steps.map((s, i) => {
        const state = s.status === "done" ? "done" : i === now ? "active" : "pending";
        const isLast = i === steps.length - 1;
        const marching = working && i === now && !isLast;
        return (
          <li key={i} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <span
                aria-hidden
                className={cn(
                  "clip-octagon grid size-5 shrink-0 place-items-center font-mono text-[10px] font-medium",
                  state === "done" && "bg-jade text-on-jade",
                  state === "active" && "bg-ochre text-on-ochre",
                  state === "pending" && "bg-sunken text-fg-subtle",
                )}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              {!isLast && (
                <span
                  aria-hidden
                  className={cn(
                    "my-0.5 min-h-3 flex-1",
                    marching ? "ant-trail-vertical" : cn("w-px", state === "done" ? "bg-jade" : "bg-line"),
                  )}
                />
              )}
            </div>
            <p
              className={cn(
                "pb-3 text-[13px] leading-5",
                state === "pending" ? "text-fg-subtle" : "text-fg",
                state === "active" && "font-medium",
              )}
            >
              {s.step}
              <span className="sr-only">
                : {state === "done" ? "done" : state === "active" ? "in progress" : "to do"}
              </span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
