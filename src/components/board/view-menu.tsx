"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { type ColumnView, type ColumnSort, type TypeFilter, EMPTY_VIEW, isViewActive } from "./view";

export interface ViewMenuProps {
  value: ColumnView;
  onChange: (view: ColumnView) => void;
  scope?: "column" | "board";
}

export function ViewMenu({ value, onChange, scope = "column" }: ViewMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = isViewActive(value);
  const buttonLabel = scope === "board" ? "Board options" : "Column options";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-ink hover:bg-cream outline-none focus-visible:bg-cream";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        className={cn(
          "border-line bg-card hover:border-clay relative inline-flex size-8 items-center justify-center rounded-md border text-muted transition-colors",
          active && "border-terracotta text-ink"
        )}
      >
        <OptionsIcon />
        {active && (
          <span className="bg-terracotta absolute top-1.5 right-1.5 size-1.5 rounded-full" />
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={buttonLabel}
          className="bg-card border-line shadow-lift absolute top-full right-0 z-50 mt-1 w-64 rounded-lg border p-1"
        >
          {/* Search input */}
          <div className="p-1.5">
            <input
              type="text"
              placeholder="Search key or title..."
              value={value.query}
              onChange={(e) => onChange({ ...value, query: e.target.value })}
              className="border-line bg-cream text-ink placeholder:text-muted focus:border-terracotta w-full rounded-md border px-2.5 py-1 text-[12px] outline-none"
            />
          </div>

          <div aria-hidden className="bg-hairline my-1 h-px" />

          {/* Sort options */}
          <div className="px-2 py-1 text-[10px] font-semibold text-muted uppercase tracking-wider">
            Sort by
          </div>
          {(
            [
              ["position", "Position"],
              ["title", "Title"],
              ["newest", "Newest"],
              ["points", "Story Points"],
            ] as const
          ).map(([sortVal, sortLabel]) => (
            <button
              key={sortVal}
              type="button"
              role="menuitemradio"
              aria-checked={value.sort === sortVal}
              className={itemClass}
              onClick={() => onChange({ ...value, sort: sortVal as ColumnSort })}
            >
              <span className="flex-1 truncate">{sortLabel}</span>
              {value.sort === sortVal && <Check />}
            </button>
          ))}

          <div aria-hidden className="bg-hairline my-1 h-px" />

          {/* Work Type filter */}
          <div className="px-2 py-1 text-[10px] font-semibold text-muted uppercase tracking-wider">
            Filter type
          </div>
          {(
            [
              ["ticket", "Tickets"],
              ["bug", "Bugs"],
              ["spike", "Spikes"],
              ["archived", "Archived"],
            ] as const
          ).map(([typeVal, typeLabel]) => {
            const checked = value.types.includes(typeVal);
            return (
              <button
                key={typeVal}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className={itemClass}
                onClick={() =>
                  onChange({
                    ...value,
                    types: checked
                      ? value.types.filter((t) => t !== typeVal)
                      : [...value.types, typeVal as TypeFilter],
                  })
                }
              >
                <span className="flex-1 truncate">{typeLabel}</span>
                {checked && <Check />}
              </button>
            );
          })}

          <div aria-hidden className="bg-hairline my-1 h-px" />

          {/* Collapse / Expand */}
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => onChange({ ...value, collapsed: !value.collapsed })}
          >
            <span className="flex-1 truncate">
              {value.collapsed
                ? scope === "board"
                  ? "Expand all"
                  : "Expand column"
                : scope === "board"
                  ? "Collapse all"
                  : "Collapse column"}
            </span>
          </button>

          {/* Clear */}
          {active && (
            <>
              <div aria-hidden className="bg-hairline my-1 h-px" />
              <button
                type="button"
                role="menuitem"
                className={cn(itemClass, "text-terracotta font-semibold")}
                onClick={() => onChange(EMPTY_VIEW)}
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OptionsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 3.5h10M4 7h6M5.5 10.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M2.5 6.5 5 9l4.5-5.5" stroke="var(--color-jade)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
