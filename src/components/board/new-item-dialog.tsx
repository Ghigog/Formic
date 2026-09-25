"use client";

import { useEffect, useId, useRef, useState } from "react";
import { BUG_COST, isBugText } from "@/lib/colony/game";
import { AttachmentPicker } from "./attachment-picker";

/** Which column's capture dialog this is: swaps its copy and submit target. */
export type CaptureColumn = "backlog" | "todo";

const COPY: Record<
  CaptureColumn,
  {
    title: string;
    agentLabel: string;
    inputLabel: string;
    placeholder: string;
    minLengthError: string;
    submitLabel: string;
  }
> = {
  backlog: {
    title: "New request",
    agentLabel: "Product Agent",
    inputLabel: "New feature request",
    placeholder: "Describe a feature or a bug",
    minLengthError: "Describe the feature or bug in a sentence or two.",
    submitLabel: "Draft PRD",
  },
  todo: {
    title: "New ticket",
    agentLabel: "Architect Agent",
    inputLabel: "New ticket request",
    placeholder: "Describe the small piece of work",
    minLengthError: "Describe the ticket in a sentence or two.",
    submitLabel: "Draft ticket",
  },
};

/**
 * Raw request capture: a feature or a bug for the Backlog, or a small piece
 * of work for To Do, in the person's own words. This is stage 1 of the
 * lifecycle: whatever is typed here is what the Product or Architect Agent
 * expands into a PRD or a ticket.
 */
export function NewItemDialog({
  open,
  column,
  onClose,
  onSubmit,
}: {
  open: boolean;
  column: CaptureColumn;
  onClose: () => void;
  /** `requestId` is the id its attachments were uploaded against. */
  onSubmit: (rawRequest: string, requestId: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const ref = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const inputId = useId();
  const copy = COPY[column];

  // A fresh dialog, and a fresh requestId for its attachments, each time it opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValue("");
      setError(null);
      setRequestId(crypto.randomUUID());
    }
  }

  useEffect(() => {
    // Focus after the dialog paints, or the caret lands nowhere.
    if (open) requestAnimationFrame(() => ref.current?.focus());
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
      setError(copy.minLengthError);
      ref.current?.animate?.(
        [{ transform: "none" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "none" }],
        { duration: 240 },
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim(), requestId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const bug = isBugText(value);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center bg-[color-mix(in_srgb,var(--anthracite)_32%,transparent)] p-0 backdrop-blur-[3px] motion-safe:animate-[reqFade_160ms_ease-out] sm:items-center sm:p-6"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Full-width bottom sheet on mobile, centered modal above it. */}
      <form
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="bg-card border-line box-border flex w-full max-w-[520px] flex-col gap-3.5 rounded-t-xl border p-5 shadow-[0_30px_60px_-24px_color-mix(in_srgb,var(--anthracite)_45%,transparent)] motion-safe:animate-[reqPop_240ms_cubic-bezier(.2,.9,.3,1.15)] sm:rounded-xl"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={titleId} className="text-ink m-0 text-[16px] font-semibold">
            {copy.title}
          </h2>
          <span className={bug ? "text-[11px] text-crimson-chip-text" : "text-muted text-[11px]"}>
            {bug ? `Tagged as bug · −${BUG_COST} points` : copy.agentLabel}
          </span>
        </div>

        <label htmlFor={inputId} className="sr-only">
          {copy.inputLabel}
        </label>
        <textarea
          id={inputId}
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          rows={5}
          placeholder={copy.placeholder}
          className="border-line bg-cream text-ink placeholder:text-muted focus:outline-terracotta box-border min-h-[110px] w-full resize-y rounded-lg border px-3 py-2.5 text-[14px] leading-[1.5]"
        />

        <AttachmentPicker requestId={requestId} />

        {error && (
          <p role="alert" className="text-crimson -mt-1.5 text-[12px]">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <span className="text-muted hidden font-mono text-[10px] sm:inline">⌘↵ to draft · Esc to close</span>
          <div className="flex-grow" />
          <button
            type="button"
            onClick={onClose}
            className="border-line bg-card text-ink h-[34px] rounded-lg border px-3 text-[13px] font-medium active:scale-[0.96]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="bg-terracotta-cta h-[34px] rounded-lg px-3.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 active:scale-[0.96] disabled:opacity-60"
          >
            {busy ? "Drafting…" : copy.submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
