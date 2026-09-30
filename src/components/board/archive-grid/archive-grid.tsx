"use client";

import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "done"; tickets: BoardCard[] };

/** A minimal card for an archived ticket: its key and title. */
function ArchivedTicketCard({ ticket }: { ticket: BoardCard }) {
  return (
    <li className="bg-card border-line rounded-lg border p-3">
      <div className="text-ink-3 text-xs">{ticket.key}</div>
      <div className="text-ink text-sm">{ticket.title}</div>
    </li>
  );
}

/** Every archived ticket of the project, in a dismissible grid. Fetches on open. */
export function ArchiveGrid({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return open ? <OpenArchiveGrid onClose={onClose} /> : null;
}

/** Mounted only while open, so every opening starts loading afresh. */
function OpenArchiveGrid({ onClose }: { onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tickets/archived")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<{ tickets: BoardCard[] }>;
      })
      .then((body) => {
        if (!cancelled) setLoad({ state: "done", tickets: body.tickets });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="Archived tickets" className="bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-ink text-sm font-medium">Archived tickets</h2>
        <button
          type="button"
          onClick={onClose}
          className="border-line text-ink rounded-md border px-2.5 py-1 text-xs"
        >
          Close
        </button>
      </div>
      {load.state === "loading" && <p>Loading archived tickets…</p>}
      {load.state === "error" && <p>Could not load archived tickets.</p>}
      {load.state === "done" && load.tickets.length === 0 && (
        <p>No archived tickets yet.</p>
      )}
      {load.state === "done" && load.tickets.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {load.tickets.map((t) => (
            <ArchivedTicketCard key={t.id} ticket={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
