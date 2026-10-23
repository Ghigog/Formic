"use client";

import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { columnFor } from "@/lib/domain/status";

/**
 * Places an unspent Queen on a Todo ticket from its drawer, the same call the
 * nest's drag makes, or takes the ticket's Queen off again (src/app/api/queens/route.ts).
 */
export function QueenPanel({ card, onChanged }: { card: BoardCard; onChanged: () => void }) {
  const [unspent, setUnspent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = card.kind === "ticket" && columnFor(card.status, card.stalledIn) === "todo";
  const hasQueen = !!card.queen;

  useEffect(() => {
    if (!shown || hasQueen) return;
    fetch("/api/queens", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ unspent: number }>) : null))
      .then(
        (found) => found && setUnspent(found.unspent),
        () => {},
      );
  }, [shown, hasQueen, card.id]);

  const send = async (method: "POST" | "DELETE") => {
    setBusy(true);
    try {
      const res = await fetch("/api/queens", {
        method,
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
  const none = !hasQueen && unspent === 0;

  return (
    <div data-queen className="flex flex-wrap items-center gap-2 text-[12px]">
      <button
        type="button"
        disabled={busy || (!hasQueen && (unspent === null || none))}
        onClick={() => void send(hasQueen ? "DELETE" : "POST")}
        className="bg-ink text-bg rounded px-2.5 py-1 font-medium disabled:opacity-50"
      >
        {hasQueen ? "Remove Queen" : "Add Queen"}
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
