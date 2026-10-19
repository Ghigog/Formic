"use client";

import { useColonySettings } from "./colony-settings";

/** The nest's one colony control: whether idle reserve sends scouts on its own. */
export function ColonyPanel({ level }: { level: number }) {
  const { view, error, save } = useColonySettings(level);
  if (!view) return null;

  const locked = view.level < view.autoScoutLevel;
  const capped = view.colonySize !== null;
  const label = locked
    ? `Auto-scout · unlocks at Lv ${view.autoScoutLevel}`
    : !capped
      ? "Auto-scout · needs a colony cap (set in Settings)"
      : "Auto-scout";

  return (
    <div data-colony-panel className="bg-panel flex flex-col gap-1 rounded-lg px-3 py-2.5">
      <button
        type="button"
        aria-pressed={view.autoScout}
        disabled={locked || !capped}
        onClick={() =>
          void save({ colonySize: view.colonySize, colonyReserve: view.colonyReserve, autoScout: !view.autoScout })
        }
        className={`border-line rounded-md border px-2.5 py-1.5 text-left text-[12px] font-semibold disabled:opacity-50 ${
          view.autoScout ? "bg-clay text-white" : "bg-card text-ink"
        }`}
      >
        {label}
        {!locked && capped && <span className="font-mono"> · {view.autoScout ? "on" : "off"}</span>}
      </button>
      {error && (
        <span role="alert" className="text-log-error text-[11px]">
          {error}
        </span>
      )}
    </div>
  );
}
