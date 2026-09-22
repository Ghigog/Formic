import { cn } from "./cn";
import { STATUS_LABEL, TONES, isLive, toneFor, type ToneName } from "@/lib/tokens";
import type { TicketStatus } from "@/lib/domain/status";

/**
 * A status chip: 12% tint of the status colour, anthracite label, 5px dot.
 *
 * The colour lives in the dot alone. Tinting the label instead would force a
 * darker variant of every status colour to clear 4.5:1, and the palette would
 * drift one state at a time.
 */
export function StatusChip({
  tone = "neutral",
  pulsing = false,
  children,
  className,
}: {
  tone?: ToneName;
  /** Only a live agent breathes. */
  pulsing?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={cn(
        "text-ink inline-flex items-center gap-[5px] rounded-full px-2 py-[3px]",
        "text-[10px] leading-4 font-semibold whitespace-nowrap",
        t.chip,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-[5px] shrink-0 rounded-full",
          t.dot,
          pulsing && "pulse-dot",
        )}
      />
      {children}
    </span>
  );
}

/** The same chip, driven by a card's domain status. */
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
  return (
    <span
      className={cn(
        "text-ink inline-flex items-center gap-[5px] rounded-full px-2 py-[3px]",
        "text-[10px] leading-4 font-semibold whitespace-nowrap",
        tone.chip,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-[5px] shrink-0 rounded-full",
          tone.dot,
          isLive(status) && "pulse-dot",
        )}
      />
      {STATUS_LABEL[status]}
      {detail ? <span className="text-muted font-normal">· {detail}</span> : null}
    </span>
  );
}
