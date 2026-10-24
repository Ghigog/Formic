"use client";

import { useEffect, useState } from "react";
import { COLUMN_LABELS } from "@/lib/domain/status";
import type { TimelineEntry } from "@/lib/kpi/compute";
import { formatDuration } from "./format-duration";

interface TicketKpiView {
  entries: TimelineEntry[];
  passRate: number | null;
  precision: { changes: number; precise: boolean };
}

const formatTime = (iso: string) => new Date(iso).toLocaleString();

/** How a ticket moved between columns, how often review passed it and how well it was specified. */
export function TicketKpis({ ticketId }: { ticketId: string }) {
  const [kpis, setKpis] = useState<TicketKpiView | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/kpi/tickets/${ticketId}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<TicketKpiView>) : null))
      .then(
        (found) => live && Array.isArray(found?.entries) && setKpis(found),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [ticketId]);

  if (!kpis) return null;
  return (
    <div>
      <h3 className="text-fg-subtle font-mono text-[10px] tracking-wide uppercase">
        Timeline
      </h3>
      <dl className="mt-1 flex gap-4 text-[12px]">
        <div>
          <dt className="text-fg-muted inline">Pass rate </dt>
          <dd className="inline font-semibold tabular-nums">
            {kpis.passRate == null
              ? "–"
              : `${Math.round(kpis.passRate * 100)}%`}
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted inline">Precision </dt>
          <dd className="inline font-semibold tabular-nums">
            {kpis.precision.changes}
          </dd>
        </div>
      </dl>
      <ol className="mt-1 space-y-1">
        {kpis.entries.map((e, i) => (
          <li key={i} className="text-[12px]">
            <span className="font-medium">{COLUMN_LABELS[e.column]}</span>
            <span className="text-fg-muted">
              {" "}
              entered {formatTime(e.enteredAt)}
              {" · "}
              {e.exitedAt ? `exited ${formatTime(e.exitedAt)}` : "still here"}
              {" · "}
              {formatDuration(e.durationMs)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
