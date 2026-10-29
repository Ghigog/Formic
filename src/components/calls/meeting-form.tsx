"use client";

import { useState } from "react";
import type { GuestId } from "@/lib/calls/guests";
import type { MeetingRepeat } from "@/lib/db/repository";
import type { MeetingInput } from "@/lib/hooks/use-meetings";

const REPEAT_LABELS: Record<MeetingRepeat, string> = {
  none: "Does not repeat",
  weekdays: "Every weekday",
  weekly: "Every week",
  biweekly: "Every two weeks",
};

/** Schedules a meeting at the slot's time with guests, an agenda and a repeat. */
export function MeetingForm({
  at,
  guests,
  onSave,
  onCancel,
}: {
  at: Date;
  /** The guests on offer. */
  guests: { id: GuestId; label: string }[];
  onSave: (input: MeetingInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [picked, setPicked] = useState<GuestId[]>([]);
  const [repeat, setRepeat] = useState<MeetingRepeat>("none");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({ title, startsAt: at, agenda, guests: picked, repeat });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save. Try again.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="New meeting" className="border-line bg-card grid max-w-md gap-3 rounded border p-4">
      <p>
        <span className="text-muted">Starts </span>
        <time dateTime={at.toISOString()}>
          {at.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
        </time>
      </p>
      <label className="grid gap-1">
        Title
        <input required value={title} onChange={(e) => setTitle(e.target.value)} className="border-line rounded border px-2 py-1" />
      </label>
      <label className="grid gap-1">
        Agenda
        <textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={3} className="border-line rounded border px-2 py-1" />
      </label>
      <fieldset className="grid gap-1">
        <legend>Guests</legend>
        {guests.map((g) => (
          <label key={g.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={picked.includes(g.id)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, g.id] : picked.filter((id) => id !== g.id))}
            />
            {g.label}
          </label>
        ))}
      </fieldset>
      <label className="grid gap-1">
        Repeat
        <select value={repeat} onChange={(e) => setRepeat(e.target.value as MeetingRepeat)} className="border-line rounded border px-2 py-1">
          {(Object.keys(REPEAT_LABELS) as MeetingRepeat[]).map((r) => (
            <option key={r} value={r}>
              {REPEAT_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving || !title.trim()}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
