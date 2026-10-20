"use client";

import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { columnFor } from "@/lib/domain/status";

/**
 * Places an unspent Queen on a Todo ticket from its drawer, the same call the
 * nest's drag makes (src/app/api/queens/route.ts).
 */
export function QueenPanel({ card, onChanged }: { card: BoardCard; onChanged: () => void }) {
  const [unspent, setUnspent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = card.kind === "ticket" && columnFor(card.status, card.stalledIn) === "todo" && !card.queen;

  useEffect(() => {
    if (!shown) return;
    fetch("/api/queens", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ unspent: number }>) : null))
      .then(
        (found) => found && setUnspent(found.unspent),
        () => {},
      );
  }, [shown, card.id]);

  const place = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/queens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id }),
      });
      const next = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setError(next.error ?? "Could not do that.");
      setError(null);
      onChanged();
    } catch {
      setError("Could not do that.");
    } finally {
      setBusy(false);
    }
  };

  if (!shown) return null;
  const none = unspent === 0;

  return (
    <div data-queen className="flex flex-wrap items-center gap-2 text-[12px]">
      <button
        type="button"
        disabled={busy || unspent === null || none}
        onClick={() => void place()}
        className="bg-ink text-bg rounded px-2.5 py-1 font-medium disabled:opacity-50"
      >
        Add Queen
      </button>
      {none && <span className="text-fg-muted">No unspent Queens</span>}
      {error && (
        <span role="alert" className="text-log-error text-[11px]">
          {error}
        </span>
      )}
    </div>
  );
}
