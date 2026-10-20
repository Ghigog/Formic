"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A small "i" that opens a note when pressed, and closes on a second press,
 * a press elsewhere or Escape. Pressed rather than hovered, so it works on a
 * phone too.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape closes the note first, not the colony around it.
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <span ref={root} className="inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={`border-line inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border font-serif text-[11px] leading-none font-semibold italic ${
          open ? "bg-anthracite text-cream" : "bg-card text-muted"
        }`}
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="border-line bg-card text-ink absolute top-full right-0 left-0 z-10 mt-1.5 rounded-lg border px-3 py-2.5 text-[11px] leading-[1.5] font-normal shadow-[0_16px_32px_-16px_color-mix(in_srgb,var(--anthracite)_45%,transparent)]"
        >
          {children}
        </span>
      )}
    </span>
  );
}
