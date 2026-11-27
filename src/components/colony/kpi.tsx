"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { useColony } from "./colony";
import { useSound } from "./store";
import { Progress, days, pct, prefersReducedMotion } from "./kpi-chart";
import { CycleTime, QualityChart, Throughput, TimeInColumn } from "./kpi-charts";
import { cn } from "@/components/ui/cn";
import type { ProjectKpis, KpiWindow } from "@/lib/kpi/compute";

const WINDOWS: Array<{ id: KpiWindow; label: string }> = [
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

const COUNT_UP_MS = 900;

/** Absent until the board reaches the KPIs level (`unlocked`). `startAfterMs` holds the reveal back, so it begins after the host's entrance. */
export function KpiSection({ unlocked, startAfterMs = 0 }: { unlocked: boolean; startAfterMs?: number }) {
  return unlocked ? <Kpis startAfterMs={startAfterMs} /> : null;
}

function Kpis({ startAfterMs }: { startAfterMs: number }) {
  const c = useColony();
  const [soundOn] = useSound();
  const ref = useRef<HTMLElement>(null);
  const [revealed, setRevealed] = useState(false);
  // Without an observer there is nothing to wait for: show the values at once.
  const [progress, setProgress] = useState(() => (typeof IntersectionObserver === "undefined" ? 1 : 0));
  const animating = useRef(false);
  const [win, setWin] = useState<KpiWindow>("30d");
  const [data, setData] = useState<ProjectKpis | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/kpi?window=${win}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ProjectKpis>) : Promise.reject(new Error(String(r.status)))))
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
    const timer = startAfterMs > 0 ? setTimeout(watch, startAfterMs) : undefined;
    if (!timer) watch();
    return () => {
      clearTimeout(timer);
      io?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loaded = data !== null;
  useEffect(() => {
    if (!revealed || !loaded || animating.current || prefersReducedMotion()) return;
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
    <section ref={ref} aria-label="KPIs" className="flex shrink-0 flex-col gap-3 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-ink m-0 font-serif text-[18px] font-semibold">Board KPIs</h2>
        <div role="group" aria-label="KPI window" className="border-line bg-card flex rounded-lg border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              aria-pressed={win === w.id}
              onClick={() => setWin(w.id)}
              className={cn(
                "rounded-lg px-3 py-1 text-[12px] font-medium max-md:h-11",
                win === w.id ? "bg-anthracite text-on-anthracite" : "text-muted",
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
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Tile label="Done" value={String(data.tiles.done)} />
            <Tile label="In flight" value={String(data.tiles.inFlight)} />
            <Tile label="Cycle time" value={days(data.tiles.cycleTimeDays)} />
            <Tile label="Pass rate" value={pct(data.tiles.passRate)} />
            <Tile label="Precision" value={pct(data.tiles.unchangedAfterSpec)} className="max-md:col-span-2" />
          </div>
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
  return value.replace(/\d+(\.\d+)?/, (n) => (Number(n) * p).toFixed(n.split(".")[1]?.length ?? 0));
}

function Tile({ label, value, className }: { label: string; value: string; className?: string }) {
  const p = useContext(Progress);
  return (
    <div role="group" aria-label={label} className={cn("border-line bg-card rounded-xl border px-4 py-3", className)}>
      <div className="text-muted text-[12px]">{label}</div>
      <div className="text-ink font-mono text-[22px] leading-tight font-medium">{counted(value, p)}</div>
    </div>
  );
}
