"use client";

import Link from "next/link";
import { useColony } from "@/components/colony/colony";
import type { Meeting } from "@/lib/db/repository";
import { GuestCoin } from "./guest-coin";
import { whenLabel } from "./up-next";

const REPEATS: Record<Meeting["repeat"], string> = {
  none: "",
  weekdays: "Every weekday",
  weekly: "Every week",
  biweekly: "Every two weeks",
};

const action = "border-line text-ink h-9 rounded-lg border px-3.5 text-[13px] font-semibold disabled:opacity-50";

/** One occurrence of a meeting, opened from the calendar: Join now, Edit and Delete. */
export function MeetingCard({
  meeting,
  at,
  busy,
  error,
  onEdit,
  onDelete,
  onClose,
}: {
  meeting: Meeting;
  at: Date;
  busy: boolean;
  error: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const c = useColony();
  return (
    <section aria-label={meeting.title} className="border-line bg-card grid gap-3 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <time dateTime={at.toISOString()} className="text-muted font-mono text-[11px]">
            {whenLabel(at)}
            {meeting.repeat !== "none" && ` · ${REPEATS[meeting.repeat]}`}
          </time>
          <h2 className="text-ink m-0 font-serif text-[20px] leading-tight font-semibold">{meeting.title}</h2>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="text-muted size-8 shrink-0 text-[18px] leading-none">
          ×
        </button>
      </div>
      {meeting.agenda.trim() && <p className="text-ink m-0 text-[13px] leading-5 whitespace-pre-line">{meeting.agenda}</p>}
      {meeting.guests.length > 0 && (
        <div className="flex -space-x-1.5">
          {meeting.guests.map((g) => (
            <GuestCoin key={g} id={g} size={24} />
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="bg-crimson/10 text-ink rounded-md px-3 py-2 text-[13px]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Link href={`/calls/${meeting.id}`} onClick={() => c?.sfx("chord")} className="bg-terracotta-cta inline-flex h-9 items-center rounded-lg px-3.5 text-[13px] font-semibold text-white">
          Join now
        </Link>
        <button type="button" onClick={onEdit} disabled={busy} className={action}>
          Edit
        </button>
        <button type="button" onClick={onDelete} disabled={busy} className={action}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </section>
  );
}
