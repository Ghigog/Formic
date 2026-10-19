"use client";

import { useCallback, useEffect, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { columnFor } from "@/lib/domain/status";

interface ScoutView {
  id: string;
  label: string;
  approach: string;
  status: "out" | "back" | "empty";
  summary: string | null;
  reason: string | null;
  picked: boolean;
}

interface ScoutsAnswer {
  why: string | null;
  scouts: ScoutView[];
  error?: string;
}

const STATUS_TEXT: Record<ScoutView["status"], string> = { out: "Out", back: "Back", empty: "Came back empty" };

/**
 * A ticket's scouts in its drawer: sent from In Progress, watched while they are
 * out, and the pick swappable until the ticket merges (src/lib/coder/scouts.ts).
 */
export function ScoutsPanel({ card, onChanged }: { card: BoardCard; onChanged: () => void }) {
  const [answer, setAnswer] = useState<ScoutsAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend =
    card.kind === "ticket" && !card.prNumber && columnFor(card.status, card.stalledIn) === "in_progress";
  const hasScouts = (card.scouts ?? 0) > 0 || !!card.scoutPick;

  const load = useCallback(
    () =>
      fetch(`/api/scouts?ticketId=${encodeURIComponent(card.id)}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<ScoutsAnswer>) : null))
        .then(
          (found) => found && setAnswer(found),
          () => {},
        ),
    [card.id],
  );

  // Fetched again as the ticket moves: scouts come back, a pick is made.
  const shown = canSend || hasScouts;
  useEffect(() => {
    if (shown) void load();
  }, [load, shown, card.status, card.scoutPick, card.updatedAt]);

  const post = async (body: object) => {
    setBusy(true);
    try {
      const res = await fetch("/api/scouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const next = (await res.json().catch(() => ({}))) as ScoutsAnswer;
      if (!res.ok) return setError(next.error ?? "Could not do that.");
      setError(null);
      setAnswer((a) => ({ ...a, ...next }));
      onChanged();
    } catch {
      setError("Could not do that.");
    } finally {
      setBusy(false);
    }
  };

  if (!canSend && !hasScouts) return null;
  const scouts = answer?.scouts ?? [];
  const swappable = card.status === "review" && !!card.scoutPick;

  return (
    <div data-scouts className="bg-sunken mt-3 flex flex-col gap-2 rounded-md px-3 py-2 text-[12px]">
      {canSend && !hasScouts ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink font-semibold">Send a scout</span>
          <span className="text-fg-muted">A second attempt, on the board&apos;s scout agent.</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void post({ action: "send", ticketId: card.id })}
            className="bg-amber text-on-amber rounded px-2.5 py-1 font-medium disabled:opacity-50"
          >
            Send a scout
          </button>
        </div>
      ) : (
        <>
          <span className="text-ink font-semibold">Scouts</span>
          {answer?.why && <p className="text-fg-muted m-0">{answer.why}</p>}
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {scouts.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] font-semibold">{s.label}</span>
                <span className="text-fg-muted">{s.approach}</span>
                <span className={s.picked ? "text-jade font-medium" : "text-fg-muted"}>
                  {s.picked ? "Kept" : STATUS_TEXT[s.status]}
                </span>
                {(s.summary || s.reason) && <span className="text-fg-muted truncate">· {s.summary ?? s.reason}</span>}
                {swappable && s.status === "back" && !s.picked && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void post({ action: "swap", ticketId: card.id, scoutId: s.id })}
                    className="border-line bg-card rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50"
                  >
                    Keep this one
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <span role="alert" className="text-log-error text-[11px]">
          {error}
        </span>
      )}
    </div>
  );
}
