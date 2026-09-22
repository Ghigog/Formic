"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Raw feature request capture. This is stage 1 of the lifecycle: whatever is
 * typed here is what the Product Agent expands into a PRD.
 */
export function NewItemDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (rawRequest: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
      // Focus after the dialog paints, or the caret lands nowhere.
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit() {
    if (value.trim().length < 3) {
      setError("Describe the feature in a sentence or two.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="New backlog item"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      {/* Full-screen bottom sheet on mobile, centered modal above it. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border-line w-full max-w-lg rounded-t-lg border p-4 sm:rounded-lg"
      >
        <h2 className="font-serif text-[18px] font-semibold">New backlog item</h2>
        <p className="text-fg-muted mt-1 text-[12px]">
          Describe the feature in your own words. The Product Agent turns this
          into an Epic PRD.
        </p>

        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          rows={5}
          placeholder="Let reviewers leave inline comments on a showcase."
          className="border-line bg-bg text-fg focus:border-amber mt-2 w-full resize-y rounded border p-2 text-[13px] outline-none"
        />

        {error && (
          <p role="alert" className="text-crimson-text mt-1 text-[12px]">
            {error}
          </p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg px-2 py-1 text-[12px] font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="bg-amber text-on-amber rounded px-3 py-1.5 text-[12px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add to Backlog"}
          </button>
        </div>
      </div>
    </div>
  );
}
