import { useMemo } from "react";
import { cn } from "@/components/ui/cn";
import type { BoardCard } from "@/lib/domain/entities";
import { topologicalOrder } from "@/lib/domain/dag";
import { columnFor, isStalled } from "@/lib/domain/status";
import { statusLabel, statusTone } from "@/lib/tokens";

type Tone = "done" | "active" | "pending" | "stuck" | "plum";

function toneOf(t: BoardCard): Tone {
  if (statusTone(t.status, t.blockedReason) === "plum") return "plum";
  if (isStalled(t.status)) return "stuck";
  const column = columnFor(t.status, t.stalledIn);
  if (column === "done") return "done";
  if (column === "in_review" || column === "in_progress") return "active";
  return "pending";
}

const BAR: Record<Tone, string> = {
  done: "bg-jade",
  active: "bg-ochre",
  pending: "bg-sunken",
  stuck: "bg-crimson",
  plum: "bg-plum",
};

const COUNTED = [
  ["done", "merged"],
  ["in_review", "in review"],
  ["in_progress", "in progress"],
  ["todo", "to do"],
  ["backlog", "in backlog"],
] as const;

/**
 * One segment per ticket of an Epic, in dependency order, coloured by where
 * the ticket is; the Epic drawer's progress strip once it has tickets.
 */
export function EpicTimeline({
  tickets,
  onOpenTicket,
  className,
}: {
  tickets: readonly BoardCard[];
  onOpenTicket?: (ticketId: string) => void;
  className?: string;
}) {
  const ordered = useMemo(() => {
    try {
      const order = topologicalOrder(
        tickets.map((c) => ({
          key: c.id,
          dependsOn: c.dependsOn,
          fileScope: c.fileScope,
        })),
      );
      const index = new Map(order.map((id, i) => [id, i]));
      return [...tickets].sort(
        (a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0),
      );
    } catch {
      return [...tickets];
    }
  }, [tickets]);

  const counts = COUNTED.map(([column, word]) => ({
    word,
    n: tickets.filter(
      (t) => !isStalled(t.status) && columnFor(t.status, t.stalledIn) === column,
    ).length,
  }));
  const stuck = tickets.filter((t) => isStalled(t.status)).length;
  const summary = [
    ...counts.filter((c) => c.n > 0).map((c) => `${c.n} ${c.word}`),
    ...(stuck > 0 ? [`${stuck} stuck`] : []),
  ].join(" · ");

  return (
    <div className={className}>
      <ol aria-label="Epic timeline" className="flex w-full gap-1">
        {ordered.map((t) => {
          const tone = toneOf(t);
          return (
            <li key={t.id} className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onOpenTicket?.(t.id)}
                aria-label={`${t.key} ${t.title}: ${statusLabel(t.status, t.blockedReason)}`}
                title={`${t.key} ${t.title}`}
                className="group flex h-6 w-full items-center"
              >
                <span
                  aria-hidden
                  data-tone={tone}
                  className={cn(
                    "h-2 w-full rounded-sm group-hover:opacity-80",
                    BAR[tone],
                    t.status === "running" && "pulse-dot",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ol>
      <p className="text-fg-subtle mt-1 text-[11px]">{summary}</p>
    </div>
  );
}
