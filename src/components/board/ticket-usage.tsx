import type { TicketView } from "@/lib/domain/ticket-view";

/** "12 of 20 minutes used", or just the minutes used when no budget bounds the ticket. */
export function TicketUsage({ usage }: { usage: TicketView["usage"] }) {
  const { usedMinutes, budgetMinutes } = usage;
  return (
    <p className="text-fg-muted shrink-0 text-[11px] tabular-nums">
      {budgetMinutes == null
        ? `${usedMinutes} minutes used`
        : `${usedMinutes} of ${budgetMinutes} minutes used`}
    </p>
  );
}
