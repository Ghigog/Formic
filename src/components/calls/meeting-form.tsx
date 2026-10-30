"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { GuestId } from "@/lib/calls/guests";
import type { MeetingRepeat } from "@/lib/db/repository";
import type { MeetingInput } from "@/lib/hooks/use-meetings";
import { GuestCoin } from "./calls-chrome";

const REPEAT_LABELS: Record<MeetingRepeat, string> = {
  none: "Does not repeat",
  weekdays: "Every weekday",
  weekly: "Every week",
  biweekly: "Every two weeks",
};

const field =
  "border-line bg-cream text-ink placeholder:text-muted w-full rounded-lg border px-3 py-2 text-[14px] outline-none focus:border-terracotta";

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
  const first = useRef<HTMLInputElement>(null);
  const heading = useId();

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[color-mix(in_srgb,var(--anthracite)_32%,transparent)] backdrop-blur-[3px] sm:items-center sm:p-6">
      <div aria-hidden className="absolute inset-0" onClick={onCancel} />
      <form
        onSubmit={submit}
        aria-label="New meeting"
        aria-describedby={heading}
        className="border-line bg-card relative grid max-h-[92dvh] w-full max-w-md gap-4 overflow-y-auto rounded-t-2xl border p-5 shadow-[0_28px_56px_-24px_color-mix(in_srgb,var(--anthracite)_50%,transparent)] sm:rounded-xl"
      >
        <div id={heading}>
          <p className="text-muted font-mono text-[10px] tracking-[0.1em] uppercase">
            <time dateTime={at.toISOString()}>
              {at.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
            </time>
          </p>
          <h2 className="text-ink font-serif text-[22px] leading-tight font-semibold">New meeting</h2>
        </div>
        <label className="text-ink grid gap-1.5 text-[12px] font-semibold">
          Title
          <input
            ref={first}
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Daily stand-up"
            className={field}
          />
        </label>
        <label className="text-ink grid gap-1.5 text-[12px] font-semibold">
          Agenda
          <textarea
            value={agenda}
            onChange={(e) => setAgenda(e.target.value)}
            rows={3}
            placeholder={"What shipped yesterday\nWhat's blocked\nWhat's next"}
            className={cn(field, "resize-y leading-6")}
          />
        </label>
        <fieldset className="grid gap-2">
          <legend className="text-ink mb-1.5 text-[12px] font-semibold">Guests</legend>
          <div className="flex flex-wrap gap-2">
            {guests.map((g) => {
              const on = picked.includes(g.id);
              return (
                <label
                  key={g.id}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-[13px] transition-colors has-[:focus-visible]:outline-2",
                    on ? "border-anthracite bg-anthracite text-cream" : "border-line bg-cream text-ink hover:border-terracotta",
                  )}
                >
                  <input
                    type="checkbox"
                    aria-label={g.label}
                    className="sr-only"
                    checked={on}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, g.id] : picked.filter((id) => id !== g.id))}
                  />
                  <GuestCoin id={g.id} size={22} />
                  {g.label}
                </label>
              );
            })}
          </div>
        </fieldset>
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
            className="bg-terracotta-cta h-9 rounded-lg px-4 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
