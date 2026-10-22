import { cn } from "./cn";
import { insectTint, type InsectColor } from "./tint";
import { STATUS_LABEL, STATUS_TONE, TONES, isLive, type ToneName } from "@/lib/tokens";
import type { TicketStatus } from "@/lib/domain/status";

/** The insect-palette colour each status tone's chip fill is tinted from. */
const CHIP_HUE: Record<ToneName, InsectColor> = {
  neutral: "slate",
  terracotta: "terracotta",
  clay: "ochre",
  jade: "jade",
  rust: "umber",
  crimson: "crimson",
};

/**
 * A status chip: a light tint of the status's insect colour, anthracite label, 5px dot.
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
        className,
      )}
      style={{ backgroundColor: insectTint(CHIP_HUE[tone]) }}
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
  const toneName = STATUS_TONE[status];
  const tone = TONES[toneName];
  return (
    <span
      className={cn(
        "text-ink inline-flex items-center gap-[5px] rounded-full px-2 py-[3px]",
        "text-[10px] leading-4 font-semibold whitespace-nowrap",
        className,
      )}
      style={{ backgroundColor: insectTint(CHIP_HUE[toneName]) }}
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
