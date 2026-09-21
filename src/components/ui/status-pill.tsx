import { cn } from "./cn";
import { STATUS_LABEL, toneFor } from "@/lib/tokens";
import type { TicketStatus } from "@/lib/domain/status";

/**
 * Status is the one piece of card metadata that is not a coin badge: it needs
 * to read at a glance from across a column, and an octagon at legible text
 * size is too wide for a dense card.
 */
export function StatusPill({
  status,
  detail,
  className,
}: {
  status: TicketStatus;
  detail?: string | null;
  className?: string;
}) {
  const tone = toneFor(status);
  const pulsing = status === "running";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] leading-4 font-medium",
        tone.text,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone.fill,
          pulsing && "animate-pulse",
        )}
      />
      {STATUS_LABEL[status]}
      {detail ? (
        <span className="text-fg-subtle font-normal">· {detail}</span>
      ) : null}
    </span>
  );
}
