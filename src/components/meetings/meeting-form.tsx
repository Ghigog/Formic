"use client";

import { useId, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { GuestId } from "@/lib/meetings/guests";
import { MEETING_TEMPLATES } from "@/lib/meetings/templates";
import type { Meeting, MeetingRepeat } from "@/lib/db/repository";
import type { MeetingInput } from "@/lib/hooks/use-meetings";
import { GuestCoin } from "./guest-coin";

const REPEAT_LABELS: Record<MeetingRepeat, string> = {
  none: "Does not repeat",
  weekdays: "Every weekday",
  weekly: "Every week",
  biweekly: "Every two weeks",
};

const field =
  "border-line bg-cream text-ink placeholder:text-muted w-full rounded-lg border px-3 py-2 text-[14px] outline-none focus:border-terracotta";

const pad = (n: number) => String(n).padStart(2, "0");
/** A date as a datetime-local input shows it, on the local clock. */
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Plans a meeting, or edits one: a time slot with repeat, a title, an agenda and guests. */
export function MeetingForm({
  at,
  meeting,
  guests,
  onSave,
  onCancel,
}: {
  /** The slot the meeting starts in. */
  at: Date;
  /** The meeting being edited, if any. */
  meeting?: Meeting;
  /** The guests on offer. */
  guests: { id: GuestId; label: string }[];
  onSave: (input: MeetingInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [when, setWhen] = useState(toLocalInput(meeting?.startsAt ?? at));
  const [title, setTitle] = useState(meeting?.title ?? "");
  const [agenda, setAgenda] = useState(meeting?.agenda ?? "");
  const [picked, setPicked] = useState<GuestId[]>(meeting?.guests ?? []);
  const [repeat, setRepeat] = useState<MeetingRepeat>(meeting?.repeat ?? "none");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const heading = useId();

  // A quick pick fills the agenda unless the person has written their own.
  const pick = (t: (typeof MEETING_TEMPLATES)[number]) => {
    setTitle(t.title);
    if (!agenda.trim() || MEETING_TEMPLATES.some((o) => o.agenda === agenda)) setAgenda(t.agenda);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const startsAt = new Date(when);
    if (Number.isNaN(startsAt.getTime())) return setError("Pick a date and time.");
    setSaving(true);
    setError(null);
    try {
      await onSave({ title: title.trim(), startsAt, agenda, guests: picked, repeat });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save. Try again.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} aria-labelledby={heading} className="border-line bg-card grid gap-4 rounded-xl border p-4">
      <h2 id={heading} className="text-ink m-0 font-serif text-[20px] leading-tight font-semibold">
        {meeting ? "Edit meeting" : "New meeting"}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-ink grid gap-1.5 text-[12px] font-semibold">
          Time
          <input type="datetime-local" required step={900} value={when} onChange={(e) => setWhen(e.target.value)} className={field} />
        </label>
        <label className="text-ink grid gap-1.5 text-[12px] font-semibold">
          Repeat
          <select value={repeat} onChange={(e) => setRepeat(e.target.value as MeetingRepeat)} className={field}>
            {(Object.keys(REPEAT_LABELS) as MeetingRepeat[]).map((r) => (
              <option key={r} value={r}>
                {REPEAT_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${heading}-title`} className="text-ink text-[12px] font-semibold">
          Title
        </label>
        <div className="flex flex-wrap gap-1.5">
          {MEETING_TEMPLATES.map((t) => (
            <button
              key={t.title}
              type="button"
              aria-pressed={title === t.title}
              onClick={() => pick(t)}
              className={cn(
                "h-8 rounded-full border px-3 text-[12px] font-semibold transition-colors",
                title === t.title ? "border-anthracite bg-anthracite text-on-anthracite" : "border-line bg-cream text-ink hover:border-terracotta",
              )}
            >
              {t.title}
            </button>
          ))}
        </div>
        <input id={`${heading}-title`} required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Daily stand-up" className={field} />
      </div>
      <label className="text-ink grid gap-1.5 text-[12px] font-semibold">
        Agenda
        <textarea
          value={agenda}
          onChange={(e) => setAgenda(e.target.value)}
          rows={4}
          placeholder={"What shipped yesterday\nWhat's blocked\nWhat's next"}
          className={cn(field, "resize-y leading-6")}
        />
      </label>
      <fieldset data-tour="meetings-guests" className="m-0 grid gap-2 border-0 p-0">
        <legend className="text-ink mb-1.5 p-0 text-[12px] font-semibold">Guests</legend>
        <div className="flex flex-wrap gap-2">
          {guests.map((g) => {
            const on = picked.includes(g.id);
            return (
              <label
                key={g.id}
                className={cn(
                  "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-[13px] transition-colors has-[:focus-visible]:outline-2",
                  on ? "border-anthracite bg-anthracite text-on-anthracite" : "border-line bg-cream text-ink hover:border-terracotta",
                )}
              >
                <input
                  type="checkbox"
                  aria-label={g.label}
                  className="sr-only"
                  checked={on}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, g.id] : picked.filter((id) => id !== g.id))}
                />
                <GuestCoin id={g.id} size={24} />
                {g.label}
              </label>
            );
          })}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="bg-crimson/10 text-ink rounded-md px-3 py-2 text-[13px]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="border-line text-ink h-9 rounded-lg border px-3.5 text-[13px] font-semibold">
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !title.trim()}
          className="bg-terracotta-cta h-9 rounded-lg px-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
