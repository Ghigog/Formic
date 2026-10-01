"use client";

import { useEffect, useState } from "react";
import { EMPTY_VIEW, isViewActive, type ColumnSort, type ColumnView, type TypeFilter } from "@/components/board/view";
import { loadBoardView, saveBoardView } from "@/components/board/view-setting";

const SORTS: [ColumnSort, string][] = [
  ["position", "Position"],
  ["title", "Title"],
  ["newest", "Newest"],
  ["points", "Story Points"],
];
const TYPES: [TypeFilter, string][] = [
  ["ticket", "Tickets"],
  ["bug", "Bugs"],
  ["spike", "Spikes"],
  ["archived", "Archived"],
];

/** The search, sort, type filter and collapse every column starts with on the board. */
export function BoardViewSection() {
  const [view, setView] = useState<ColumnView>(EMPTY_VIEW);

  // After mount, so the server and first client render agree.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser storage is only readable after mount
    setView(loadBoardView());
  }, []);

  function change(next: ColumnView) {
    setView(next);
    saveBoardView(next);
  }

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">
        Board view
      </h2>
      <div className="flex flex-col gap-3">
        <p className="text-muted text-[12px] leading-[1.5]">
          Applies to every column when the board loads. Applies to this browser only.
        </p>
        <input
          type="text"
          aria-label="Search"
          placeholder="Search key or title..."
          value={view.query}
          onChange={(e) => change({ ...view, query: e.target.value })}
          className="border-line bg-cream text-ink placeholder:text-muted focus:border-clay h-10 rounded-md border px-2.5 text-[13px] outline-none"
        />
        <label className="text-ink flex items-center gap-2 text-[13px]">
          Sort by
          <select
            aria-label="Sort by"
            value={view.sort}
            onChange={(e) => change({ ...view, sort: e.target.value as ColumnSort })}
            className="border-line bg-cream h-10 rounded-md border px-2 text-[13px]"
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="text-muted mb-1 text-[12px]">Filter type</legend>
          {TYPES.map(([value, label]) => (
            <label key={value} className="text-ink flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={view.types.includes(value)}
                onChange={(e) =>
                  change({
                    ...view,
                    types: e.target.checked
                      ? [...view.types, value]
                      : view.types.filter((t) => t !== value),
                  })
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="text-ink flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={view.collapsed}
            onChange={(e) => change({ ...view, collapsed: e.target.checked })}
          />
          Collapse all columns
        </label>
        {isViewActive(view) && (
          <button
            type="button"
            onClick={() => change(EMPTY_VIEW)}
            className="text-terracotta self-start text-[12px] font-semibold"
          >
            Clear
          </button>
        )}
      </div>
    </section>
  );
}
