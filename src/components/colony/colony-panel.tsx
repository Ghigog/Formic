"use client";

import { useColonySettings, type ColonyView } from "./colony-settings";

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const button =
    "border-line bg-card inline-flex size-7 items-center justify-center rounded-md border text-[13px] font-semibold disabled:opacity-40";
  return (
    <span className="inline-flex items-center gap-1.5">
      <button type="button" aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)} className={button}>
        −
      </button>
      <span aria-label={label} className="text-ink w-5 text-center font-mono text-[13px] font-semibold">
        {value}
      </span>
      <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)} className={button}>
        +
      </button>
    </span>
  );
}

/**
 * The colony's size and reserve, and what the level unlocks of them: a lower
 * reserve floor, more scouts per ticket, and scouts that go out on their own.
 */
export function ColonyPanel({ level }: { level: number }) {
  const { view, error, save } = useColonySettings(level);
  if (!view) return null;

  const capped = view.colonySize !== null;
  const size = view.colonySize ?? 4;
  const floor = Math.min(view.floor, size - 1);
  const set = (patch: Partial<Pick<ColonyView, "colonySize" | "colonyReserve" | "autoScout">>) =>
    void save({ colonySize: view.colonySize, colonyReserve: view.colonyReserve, autoScout: view.autoScout, ...patch });
  const autoLocked = view.level < view.autoScoutLevel;

  return (
    <div data-colony-panel className="bg-panel flex flex-col gap-2 rounded-lg px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink text-[12px] font-semibold">Colony</span>
        <label className="text-muted inline-flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={capped}
            onChange={(e) => set(e.target.checked ? { colonySize: size, colonyReserve: Math.max(floor, view.floor) } : { colonySize: null })}
          />
          Cap how many agents run
        </label>
      </div>

      {capped ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted text-[11px]">
              Agents at once <span className="font-mono">· {view.inUse} in use</span>
            </span>
            <Stepper
              label="agents"
              value={size}
              min={Math.max(1, view.colonyReserve + 1)}
              max={view.maxColony}
              onChange={(n) => set({ colonySize: n })}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted text-[11px]">Kept in reserve for bugs and fixes</span>
            <Stepper
              label="reserve slots"
              value={view.colonyReserve}
              min={floor}
              max={size - 1}
              onChange={(n) => set({ colonyReserve: n })}
            />
          </div>
          <span className="text-muted text-[11px]">
            {view.nextFloorLevel
              ? `At least ${view.floor} in reserve at Lv ${view.level}. Lv ${view.nextFloorLevel} lets you run closer to full.`
              : "No reserve required: you may run the colony full."}
          </span>
        </>
      ) : (
        <span className="text-muted text-[11px]">Off: only file reservations hold work back.</span>
      )}

      <div className="border-line flex flex-col gap-1 border-t pt-2">
        <span className="text-ink text-[11px] font-semibold">Scouts</span>
        <span className="text-muted text-[11px]">
          Send up to {view.maxScouts} scouts on a ticket from its drawer. Each tries its own approach; the Reviewer keeps the
          best.
        </span>
        <label className={`inline-flex items-center gap-1.5 text-[11px] ${autoLocked || !capped ? "text-muted" : "text-ink"}`}>
          <input
            type="checkbox"
            disabled={autoLocked || !capped}
            checked={view.autoScout}
            onChange={(e) => set({ autoScout: e.target.checked })}
          />
          {autoLocked
            ? `Idle reserve sends scouts on its own · unlocks at Lv ${view.autoScoutLevel}`
            : capped
              ? "Idle reserve sends scouts on spikes and retries on its own"
              : "Idle reserve sends scouts on its own · needs a capped colony"}
        </label>
      </div>
      {error && (
        <span role="alert" className="text-log-error text-[11px]">
          {error}
        </span>
      )}
    </div>
  );
}
