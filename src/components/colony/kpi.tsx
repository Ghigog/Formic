"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { useColony } from "./colony";
import { useSound } from "./store";
import { Progress, days, pct, prefersReducedMotion } from "./kpi-chart";
import {
  CycleTime,
  QualityChart,
  Throughput,
  TimeInColumn,
} from "./kpi-charts";
import { cn } from "@/components/ui/cn";
import { KpiRecords } from "./kpi-records";
import { CHANGES_AFTER_SPEC_LABEL } from "@/lib/kpi/labels";
import { kpiHeadline } from "@/lib/kpi/headline";
import type { ProjectKpis, KpiWindow, Tiles } from "@/lib/kpi/compute";

const WINDOWS: Array<{ id: KpiWindow; label: string }> = [
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

const COUNT_UP_MS = 900;

/** Absent until the board reaches the KPIs level (`unlocked`). `startAfterMs` holds the reveal back, so it begins after the host's entrance. */
export function KpiSection({
  unlocked,
  startAfterMs = 0,
}: {
  unlocked: boolean;
  startAfterMs?: number;
}) {
  return unlocked ? <Kpis startAfterMs={startAfterMs} /> : null;
}

function Kpis({ startAfterMs }: { startAfterMs: number }) {
  const c = useColony();
  const [soundOn] = useSound();
  const ref = useRef<HTMLElement>(null);
  const [revealed, setRevealed] = useState(false);
  // Without an observer there is nothing to wait for: show the values at once.
  const [progress, setProgress] = useState(() =>
    typeof IntersectionObserver === "undefined" ? 1 : 0,
  );
  const animating = useRef(false);
  const [win, setWin] = useState<KpiWindow>("30d");
  const [data, setData] = useState<ProjectKpis | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/kpi?window=${win}`, { cache: "no-store" })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<ProjectKpis>)
          : Promise.reject(new Error(String(r.status))),
      )
      .then((d) => {
        if (!live) return;
        if (!d?.tiles) throw new Error("bad shape");
        setData(d);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [win]);

  // First reveal only: the cue and the animation never repeat.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let io: IntersectionObserver | undefined;
    const watch = () => {
      io = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io?.disconnect();
        setRevealed(true);
        if (prefersReducedMotion()) setProgress(1);
        if (soundOn) c?.sfx("kpi");
      });
      io.observe(el);
    };
    const timer =
      startAfterMs > 0 ? setTimeout(watch, startAfterMs) : undefined;
    if (!timer) watch();
    return () => {
      clearTimeout(timer);
      io?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loaded = data !== null;
  useEffect(() => {
    if (!revealed || !loaded || animating.current || prefersReducedMotion())
      return;
    animating.current = true;
    let start: number | null = null;
    const step = (t: number) => {
      start ??= t;
      const p = Math.min(1, (t - start) / COUNT_UP_MS);
      setProgress(1 - Math.pow(1 - p, 3));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [revealed, loaded]);

  return (
    <Progress.Provider value={progress}>
      <section
        ref={ref}
        aria-label="KPIs"
        className="flex shrink-0 flex-col gap-3 pt-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-ink m-0 font-serif text-[18px] font-semibold">
            Board KPIs
          </h2>
          <div
            role="group"
            aria-label="KPI window"
            className="border-line bg-card flex rounded-lg border p-0.5"
          >
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                aria-pressed={win === w.id}
                onClick={() => setWin(w.id)}
                className={cn(
                  "rounded-lg px-3 py-1 text-[12px] font-medium max-md:h-11",
                  win === w.id
                    ? "bg-anthracite text-on-anthracite"
                    : "text-muted",
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        {failed && (
          <p role="alert" className="text-muted m-0 text-[12px]">
            KPIs could not be loaded.
          </p>
        )}
        {data && (
          <>
            <p
              className="text-ink m-0 text-[13px]"
              style={{ opacity: progress }}
            >
              {kpiHeadline(data)}
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {TILES.map((t) => (
                <Tile
                  key={t.label}
                  def={t}
                  tiles={data.tiles}
                  previous={data.previous}
                />
              ))}
            </div>
            <KpiRecords records={data.records} settled={progress >= 1} />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <TimeInColumn data={data.timeInColumn} />
              <QualityChart data={data.quality} />
              <Throughput data={data.throughput} />
              <CycleTime data={data.cycleTime} />
            </div>
          </>
        )}
      </section>
    </Progress.Provider>
  );
}

/** `value` with its number scaled by `p`, keeping the number's decimals and its suffix. */
function counted(value: string, p: number): string {
  if (p >= 1) return value;
  return value.replace(/\d+(\.\d+)?/, (n) =>
    (Number(n) * p).toFixed(n.split(".")[1]?.length ?? 0),
  );
}

interface TileDef {
  label: string;
  value: (t: Tiles) => string;
  /** The figure the comparison is made on. */
  figure: (t: Tiles) => number | null;
  /** Decimals of `figure` that count as a difference. */
  step: number;
  /** Writes an absolute difference, already rounded to `step`. */
  diff: (d: string) => string;
  lowerIsBetter?: boolean;
  /** No judgement: the difference shows in muted ink. */
  neutral?: boolean;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const points = (d: string) => `${d} ${d === "1" ? "point" : "points"}`;
const share = (v: number | null) => (v === null ? null : v * 100);

const TILES: TileDef[] = [
  {
    label: "Done",
    value: (t) => String(t.done),
    figure: (t) => t.done,
    step: 0,
    diff: (d) => d,
  },
  {
    label: "In flight",
    value: (t) => String(t.inFlight),
    figure: (t) => t.inFlight,
    step: 0,
    diff: (d) => d,
    neutral: true,
  },
  {
    label: "Cycle time",
    value: (t) => days(t.cycleTimeDays),
    figure: (t) => t.cycleTimeDays,
    step: 1,
    diff: (d) => `${d} d`,
    lowerIsBetter: true,
  },
  {
    label: "Pass rate",
    value: (t) => pct(t.passRate),
    figure: (t) => share(t.passRate),
    step: 0,
    diff: points,
  },
  {
    label: CHANGES_AFTER_SPEC_LABEL,
    value: (t) =>
      t.unchangedAfterSpec === null ? "–" : `${pct(t.unchangedAfterSpec)} none`,
    figure: (t) => share(t.unchangedAfterSpec),
    step: 0,
    diff: points,
  },
  {
    label: "Cost per point",
    value: (t) =>
      t.costPerPointCents === null ? "–" : dollars(t.costPerPointCents),
    figure: (t) =>
      t.costPerPointCents === null ? null : t.costPerPointCents / 100,
    step: 2,
    diff: (d) => `$${d}`,
    lowerIsBetter: true,
  },
  {
    label: "First-try rate",
    value: (t) => pct(t.firstTryRate),
    figure: (t) => share(t.firstTryRate),
    step: 0,
    diff: points,
  },
];

/** How `tiles` differs from `previous`, or null when equal or either figure is missing. */
function change(def: TileDef, tiles: Tiles, previous: Tiles) {
  const now = def.figure(tiles);
  const before = def.figure(previous);
  if (now === null || before === null) return null;
  const d = Number((now - before).toFixed(def.step));
  if (d === 0) return null;
  const text = def.diff(Math.abs(d).toFixed(def.step));
  const up = d > 0;
  const better = def.neutral ? null : up !== !!def.lowerIsBetter;
  return {
    up,
    better,
    text,
    label: `${text} ${up ? "more" : "less"} than the 30 days before`,
  };
}

function Tile({
  def,
  tiles,
  previous,
}: {
  def: TileDef;
  tiles: Tiles;
  previous: Tiles | null;
}) {
  const p = useContext(Progress);
  const ch = previous ? change(def, tiles, previous) : null;
  return (
    <div
      role="group"
      aria-label={def.label}
      className="border-line bg-card min-w-0 rounded-xl border px-4 py-3"
    >
      <div className="text-muted text-[12px]">{def.label}</div>
      <div className="text-ink font-serif text-[22px] leading-tight font-medium">
        {counted(def.value(tiles), p)}
      </div>
      {previous && (
        <div
          className={cn(
            "mt-0.5 flex min-h-4 items-center gap-1 text-[12px]",
            ch === null || ch.better === null
              ? "text-muted"
              : ch.better
                ? "text-jade"
                : "text-crimson",
          )}
        >
          {ch === null ? (
            <span aria-hidden>–</span>
          ) : (
            <>
              <span role="img" aria-label={ch.label}>
                {ch.up ? "↑" : "↓"}
              </span>
              <span aria-hidden>{ch.text}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
