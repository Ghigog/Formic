"use client";

import { useEffect } from "react";
import { NO_RESERVE_LEVEL, RESERVE_ONE_LEVEL } from "@/lib/colony/game";
import { useColonySettings, type ColonyView } from "./colony-settings";
import { Tile } from "./tile";

/** Scouts fanning out from one point: the Scouts row's mark. */
function ScoutIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3" cy="8" r="1.8" fill="currentColor" />
      <path d="M5 7 13 3M5 8h8.5M5 9l8 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="1.6 1.6" />
    </svg>
  );
}

/** A shield: the slots kept back. */
function ReserveIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5 13.5 3.5v4c0 3.4-2.3 5.9-5.5 7-3.2-1.1-5.5-3.6-5.5-7v-4Z" />
    </svg>
  );
}

function reserveCap(view: ColonyView): string {
  if (view.colonySize === null) return "No colony cap · set one in Settings";
  return `${view.colonyReserve} of ${view.colonySize} slots kept for urgent work`;
}

function reserveFloorLine(view: ColonyView): string {
  const least = view.floor === 0 ? "No least reserve" : `At least ${view.floor} at Lv ${view.level}`;
  return view.nextFloorLevel ? `${least} · Lv ${view.nextFloorLevel} lowers it` : least;
}

/** The nest's colony tiles: scouts, which toggles Auto-scout, and the reserve, which only shows it. */
export function ColonyPanel({ level, onError }: { level: number; onError?: (message: string | null) => void }) {
  const { view, error, save } = useColonySettings(level);
  useEffect(() => onError?.(error), [error, onError]);
  if (!view) return null;

  const locked = view.level < view.autoScoutLevel;
  const capped = view.colonySize !== null;
  const lockReason = locked
    ? `Auto-scout unlocks at Lv ${view.autoScoutLevel}.`
    : !capped
      ? "Auto-scout needs a colony cap (set in Settings)."
      : "Tap the tile to turn Auto-scout on or off.";

  return (
    <>
      <Tile
        data="scouts"
        icon={<ScoutIcon />}
        value={view.maxScouts}
        valueData={{ "data-scout-cap": "" }}
        tipLabel="How scouts work"
        tip={
          <>
            Up to {view.maxScouts} per ticket
            {view.nextScoutLevel ? ` · Lv ${view.nextScoutLevel} allows ${view.maxScouts + 1}` : ""}. Send scouts from a
            ticket&apos;s drawer while it is in To Do. Each is a copy of the ticket that tries its own approach on its
            own branch. When they are back, the Reviewer picks the best and the ticket carries on with it. Each scout
            takes a colony slot while it is out. From Lv {view.autoScoutLevel}, Auto-scout lets idle reserve slots
            scout on their own. {lockReason}
          </>
        }
      >
        <button
          type="button"
          aria-label={locked || !capped ? `Auto-scout · ${lockReason}` : "Auto-scout"}
          aria-pressed={view.autoScout}
          disabled={locked || !capped}
          onClick={() =>
            void save({ colonySize: view.colonySize, colonyReserve: view.colonyReserve, autoScout: !view.autoScout })
          }
          className={`col-start-1 row-start-1 flex items-end justify-start rounded-lg p-1.5 disabled:opacity-60 ${
            view.autoScout ? "ring-clay ring-2 ring-inset" : ""
          }`}
        >
          <span className="font-mono text-[10px] font-semibold">
            {locked || !capped ? "locked" : view.autoScout ? "auto on" : "auto off"}
          </span>
        </button>
      </Tile>

      <Tile
        data="reserve"
        icon={<ReserveIcon />}
        value={capped ? view.colonyReserve : "off"}
        valueData={{ "data-reserve-cap": "" }}
        tipLabel="How the colony reserve works"
        tip={
          <>
            {reserveCap(view)}. {reserveFloorLine(view)}. The colony size caps how many agents this board runs at once.
            The reserve is the slots routine work may not use, so a bug, or a ticket back from review with its pull
            request open, can always start. Your level sets the least reserve: 2 to start, 1 from Lv {RESERVE_ONE_LEVEL},
            none from Lv {NO_RESERVE_LEVEL}. Set both in Settings.
          </>
        }
      />
    </>
  );
}
