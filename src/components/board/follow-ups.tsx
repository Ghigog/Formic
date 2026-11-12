"use client";

import { useState } from "react";

import type { FollowUp, FollowUpOutcome } from "@/lib/agents/follow-ups";

const CAPTION = "font-mono text-[10px] tracking-wide uppercase";
const CHIP = `${CAPTION} border-line bg-card rounded border px-1.5 py-0.5`;

/** Where a follow-up went: a chip for its outcome, or buttons when it has none (recorded before outcomes). */
function Outcome({
  outcome,
  onOpenCard,
  onOpenChat,
}: {
  outcome: FollowUpOutcome;
  onOpenCard: (cardId: string) => void;
  onOpenChat: () => void;
}) {
  switch (outcome.kind) {
    case "added":
      return (
        <button
          type="button"
          onClick={() => onOpenCard(outcome.cardId)}
          className={`${CHIP} text-fg whitespace-nowrap`}
        >
          Added as {outcome.key}
        </button>
      );
    case "proposed":
      return (
        <button
          type="button"
          onClick={onOpenChat}
          className={`${CHIP} text-fg whitespace-nowrap`}
        >
          Proposed in chat
        </button>
      );
    case "dismissed":
      return (
        <span className={`${CHIP} text-fg-subtle whitespace-nowrap`}>
          Dismissed
        </span>
      );
    case "pending":
      return (
        <span className={`${CHIP} text-fg-subtle whitespace-nowrap`}>
          Pending
        </span>
      );
  }
}

/**
 * Work the ticket's agents found that is not this ticket's, and where each
 * went: onto the board, into the PM's chat, or dismissed. One recorded before
 * outcomes existed can still be added or dismissed here.
 */
export function FollowUps({
  ticketId,
  followUps,
  onChanged,
  onOpenCard,
  onOpenChat,
}: {
  ticketId: string;
  followUps: FollowUp[];
  onChanged: () => void;
  onOpenCard: (cardId: string) => void;
  onOpenChat: () => void;
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
      <h3 className="text-fg-subtle font-mono text-[10px] tracking-wide uppercase">
        Follow-ups
      </h3>
      <p className="text-fg-muted mt-1 text-[12px]">
        Work its agents found that is bigger than this ticket or belongs to
        another. Needed work is added to To Do; optional work is proposed in the
        PM&apos;s chat.
      </p>
      <ul className="mt-1 space-y-1.5">
        {followUps.map((f, i) => (
          <li
            key={f.title}
            className="border-line bg-surface rounded-md border px-2 py-1.5"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span className="font-medium">{f.title}</span>
                {f.points != null && (
                  <span className="text-fg-subtle ml-1.5 text-[11px]">
                    {f.points} pt
                  </span>
                )}
                <span className={`${CAPTION} text-fg-subtle ml-1.5`}>
                  {f.need === "needed" ? "Needed" : "Nice to have"}
                </span>
                {f.why && (
                  <p className="text-fg-muted m-0 text-[12px]">{f.why}</p>
                )}
              </div>
              {f.outcome ? (
                <Outcome
                  outcome={f.outcome}
                  onOpenCard={onOpenCard}
                  onOpenChat={onOpenChat}
                />
              ) : (
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
              )}
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
