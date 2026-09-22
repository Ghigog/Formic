"use client";

import { useId, useState } from "react";

/**
 * The inline Backlog composer. A real input at the head of the column rather
 * than a modal: capturing a raw request is the cheapest thing on the board,
 * and stage 1 should cost one click.
 *
 * Whatever is typed here is what the Product Agent expands into a PRD.
 */
export function BacklogComposer({
  onSubmit,
}: {
  onSubmit: (rawRequest: string) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = value.trim();
    if (text.length < 3) {
      setError("Describe the feature in a sentence.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="bg-card border-line-dashed flex flex-col gap-2 rounded-lg border border-dashed p-3"
    >
      <label className="sr-only" htmlFor={id}>
        New feature request
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Let agents open draft PRs for spikes"
        className="border-line bg-cream text-ink placeholder:text-muted h-8 w-full rounded-md border px-2 text-[12px]"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="bg-terracotta-cta h-[30px] rounded-md px-2.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Drafting…" : "Draft PRD"}
        </button>
        <span className="text-muted text-[11px]">Product Agent</span>
      </div>
      {error && (
        <p role="alert" className="text-crimson text-[11px]">
          {error}
        </p>
      )}
    </form>
  );
}
