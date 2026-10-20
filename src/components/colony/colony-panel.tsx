"use client";

import type { ReactNode } from "react";
import { useColonySettings, type ColonyView } from "./colony-settings";
import { InfoTip } from "./info-tip";

/** Scouts fanning out from one point: the Scouts row's mark. */
function ScoutIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3" cy="8" r="1.8" fill="currentColor" />
      <path d="M5 7 13 3M5 8h8.5M5 9l8 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="1.6 1.6" />
    </svg>
  );
}

/** A shield: the slots kept back. */
function ReserveIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5 13.5 3.5v4c0 3.4-2.3 5.9-5.5 7-3.2-1.1-5.5-3.6-5.5-7v-4Z" />
    </svg>
  );
}

/** One line of the colony: a mark, a name with its info tip, and its cap. */
function Row({
  icon,
  title,
  tipLabel,
  tip,
  children,
  data,
}: {
  icon: ReactNode;
  title: ReactNode;
  tipLabel: string;
  tip: ReactNode;
  children: ReactNode;
  data: string;
}) {
  return (
    <div data-colony-row={data} className="bg-panel relative flex items-start gap-3 rounded-lg px-3 py-2.5">
      <span className="text-clay inline-flex shrink-0 pt-0.5">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ink flex items-center gap-1.5 text-[12px] font-semibold">
          <span>{title}</span>
          <InfoTip label={tipLabel}>{tip}</InfoTip>
        </span>
        {children}
      </div>
    </div>
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

/** The nest's colony rows: scouts and the reserve, each with what the level allows. */
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
    <div data-colony-panel className="flex flex-col gap-4">
      <Row
        data="scouts"
        icon={<ScoutIcon />}
        title={<>Scouts <span data-scout-cap>{view.maxScouts}</span></>}
        tipLabel="How scouts work"
        tip={
          <>
            Send scouts from a ticket&apos;s drawer while it is in To Do. Each is a copy of the ticket that tries its own
            approach on its own branch. When they are back, the Reviewer picks the best and the ticket carries on with
            it. Each scout takes a colony slot while it is out. From Lv {view.autoScoutLevel}, Auto-scout lets idle
            reserve slots scout on their own.
          </>
        }
      >
        <span className="text-muted text-[11px]">
          Up to {view.maxScouts} per ticket
          {view.nextScoutLevel ? ` · Lv ${view.nextScoutLevel} allows ${view.maxScouts + 1}` : ""}
        </span>
        <button
          type="button"
          aria-pressed={view.autoScout}
          disabled={locked || !capped}
          onClick={() =>
            void save({ colonySize: view.colonySize, colonyReserve: view.colonyReserve, autoScout: !view.autoScout })
          }
          className={`border-line mt-1.5 rounded-md border px-2.5 py-1.5 text-left text-[12px] font-semibold disabled:opacity-50 ${
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
      </Row>

      <Row
        data="reserve"
        icon={<ReserveIcon />}
        title={<>Reserve <span data-reserve-cap>{capped ? view.colonyReserve : "off"}</span></>}
        tipLabel="How the colony reserve works"
        tip={
          <>
            The colony size caps how many agents this board runs at once. The reserve is the slots routine work may not
            use, so a bug, or a ticket back from review with its pull request open, can always start. Your level sets
            the least reserve: 2 to start, 1 from Lv 3, none from Lv 6. Set both in Settings.
          </>
        }
      >
        <span className="text-muted text-[11px]">{reserveCap(view)}</span>
        <span className="text-muted text-[11px]">{reserveFloorLine(view)}</span>
      </Row>
    </div>
  );
}
