"use client";

import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { COLUMN_LABELS, columnOf } from "@/lib/domain/status";

type ArchivePage = {
  tickets: BoardCard[];
  epics?: BoardCard[];
  nextCursor?: string | null;
};

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

  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/tickets/archived")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load"))))
      .then((body: ArchivePage) => {
        if (!live) return;
        setCards([...body.tickets, ...(body.epics ?? [])]);
        setNextCursor(body.nextCursor ?? null);
      })
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

  const showOlder = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const res = await fetch(`/api/tickets/archived?cursor=${encodeURIComponent(nextCursor)}`);
      if (!res.ok) throw new Error("page");
      const body: ArchivePage = await res.json();
      setCards((prev) => {
        const seen = new Set(prev?.map((c) => c.id));
        const older = [...body.tickets, ...(body.epics ?? [])].filter((c) => !seen.has(c.id));
        return [...(prev ?? []), ...older];
      });
      setNextCursor(body.nextCursor ?? null);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async (card: BoardCard) => {
    setError(null);
    try {
      const res = await fetch(
        `/api/${card.kind === "epic" ? "epics" : "tickets"}/${card.id}/archive`,
        { method: "DELETE" },
      );
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
        role="presentation"
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
        {cards?.length === 0 && !error && <p className="text-sm text-white">No archived cards.</p>}
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
        {nextCursor && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1">
            {loadingMore ? (
              <span role="status" className="py-3 text-sm text-white/70 motion-safe:animate-pulse">
                Loading…
              </span>
            ) : (
              <button
                type="button"
                onClick={showOlder}
                className="-my-0 min-h-11 py-3 text-sm text-white/70 underline-offset-2 hover:text-white hover:underline"
              >
                Show older
              </button>
            )}
            {moreError && (
              <p role="alert" className="text-sm text-white">
                Could not load older cards. The ones above are still here.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
