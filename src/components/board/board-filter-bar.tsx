"use client";

import { ViewMenu } from "./view-menu";
import type { ColumnView } from "./view";

export interface BoardFilterBarProps {
  value: ColumnView;
  onChange: (view: ColumnView) => void;
}

/** The board's filter box and options: narrows every column as you type. */
export function BoardFilterBar({ value, onChange }: BoardFilterBarProps) {
  return (
    <div className="border-line bg-cream flex shrink-0 items-center gap-2 border-b px-4 py-2 md:px-6">
      <div className="relative min-w-0 flex-1 md:max-w-sm">
        <input
          type="text"
          aria-label="Filter cards"
          placeholder="Filter by key or title…"
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value.query) {
              e.preventDefault();
              onChange({ ...value, query: "" });
            }
          }}
          className="border-line bg-cream text-ink placeholder:text-muted focus:border-terracotta h-11 w-full rounded-md border pr-11 pl-2.5 text-[13px] outline-none md:h-8 md:pr-8 md:text-[12px]"
        />
        {value.query && (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => onChange({ ...value, query: "" })}
            className="text-muted hover:text-ink absolute top-0 right-0 flex size-11 items-center justify-center text-[13px] leading-none md:size-8"
          >
            ×
          </button>
        )}
      </div>
      <ViewMenu scope="board" search={false} value={value} onChange={onChange} />
    </div>
  );
}
