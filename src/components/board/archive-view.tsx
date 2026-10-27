"use client";

import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { COLUMN_LABELS, columnOf } from "@/lib/domain/status";

/**
 * The Archived view: a full-screen overlay over a blurred board, listing every
 * archived card. Clicking one restores it to the column it came from.
 */
export function ArchiveView({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  /** A card was restored: the board should show it in its column. */
  onRestored: (card: BoardCard) => void;
}) {
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/tickets/archived")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load"))))
      .then((body: { tickets: BoardCard[] }) => live && setCards(body.tickets))
      .catch(() => {
        if (live) {
          setCards([]);
          setError("Could not load the archive.");
        }
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async (card: BoardCard) => {
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${card.id}/archive`, { method: "DELETE" });
      if (!res.ok) throw new Error("restore");
      setCards((prev) => prev?.filter((c) => c.id !== card.id) ?? prev);
      onRestored({ ...card, archived: false });
    } catch {
      setError(`Could not restore ${card.key}. Try again.`);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Archived"
      className="fixed inset-0 z-50 overflow-y-auto p-6"
    >
      <div
        data-testid="archive-backdrop"
        className="fixed inset-0 bg-black/60 backdrop-blur-md"
        onClick={onClose}
      />
      <div className="relative mx-auto max-w-5xl">
        <h2 className="mb-4 text-lg font-semibold text-white">Archived</h2>
        {error && (
          <p role="alert" className="mb-4 rounded-md bg-white px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {cards?.length === 0 && !error && (
          <p className="text-sm text-white">No archived cards.</p>
        )}
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards?.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                onClick={() => restore(card)}
                aria-label={`Restore ${card.key} ${card.title}`}
                className="bg-card border-line w-full rounded-lg border p-3 text-left"
              >
                <span className="text-muted block text-xs">
                  {card.key} · {COLUMN_LABELS[columnOf(card)]}
                </span>
                <span className="block text-sm font-medium">{card.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
