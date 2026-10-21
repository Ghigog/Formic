"use client";

import { useState } from "react";

import type { FollowUp } from "@/lib/agents/follow-ups";

/**
 * Work the ticket's agents found that is not this ticket's: each can be added
 * as a tech debt ticket on the same Epic, or dismissed.
 */
export function FollowUps({
  ticketId,
  followUps,
  onChanged,
}: {
  ticketId: string;
  followUps: FollowUp[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (followUps.length === 0) return null;

  const answer = async (index: number, add: boolean) => {
    setBusy(index);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/follow-ups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index, add }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setError(body.error ?? "Could not do that.");
      setError(null);
      onChanged();
    } catch {
      setError("Could not do that.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h3 className="text-fg-subtle font-mono text-[10px] tracking-wide uppercase">Follow-ups</h3>
      <p className="text-fg-muted mt-1 text-[12px]">
        Work its agents found that is bigger than this ticket or belongs to another. Add one as its own tech debt
        ticket on this Epic, or dismiss it.
      </p>
      <ul className="mt-1 space-y-1.5">
        {followUps.map((f, i) => (
          <li key={f.title} className="border-line bg-surface rounded-md border px-2 py-1.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span className="font-medium">{f.title}</span>
                {f.points != null && <span className="text-fg-subtle ml-1.5 text-[11px]">{f.points} pt</span>}
                {f.why && <p className="text-fg-muted m-0 text-[12px]">{f.why}</p>}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void answer(i, true)}
                  className="bg-ink text-bg rounded px-2 py-0.5 text-[11px] font-medium whitespace-nowrap disabled:opacity-50"
                >
                  Add ticket
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void answer(i, false)}
                  className="border-line bg-card rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-log-error mt-1 text-[11px]">
          {error}
        </p>
      )}
    </div>
  );
}
