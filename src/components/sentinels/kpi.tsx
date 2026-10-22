"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { COLUMNS, COLUMN_LABELS } from "@/lib/domain/status";
import type { ProjectKpis, KpiWindow } from "@/lib/kpi/compute";

const WINDOWS: Array<{ id: KpiWindow; label: string }> = [
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

const W = 320;
const H = 140;
const PAD = { l: 34, r: 8, t: 8, b: 22 };
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const days = (v: number | null) => (v === null ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)} d`);

export function KpiSection() {
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

  return (
    <section aria-label="KPIs" className="flex shrink-0 flex-col gap-3 pt-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-ink m-0 font-serif text-[20px] font-semibold">Board KPIs</h2>
        <div role="group" aria-label="KPI window" className="border-line bg-card flex rounded-[10px] border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              aria-pressed={win === w.id}
              onClick={() => setWin(w.id)}
              className={cn(
                "rounded-lg px-3 py-1 text-[12px] font-medium",
                win === w.id ? "bg-anthracite text-cream" : "text-muted",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      {failed && (
        <p role="alert" className="text-muted m-0 text-[13px]">
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
            <Tile label="Precision" value={pct(data.tiles.precision)} />
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
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div role="group" aria-label={label} className="border-line bg-card rounded-[14px] border px-4 py-3">
      <div className="text-muted text-[12px]">{label}</div>
      <div className="text-ink font-mono text-[26px] leading-tight font-medium">{value}</div>
    </div>
  );
}

function Chart({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  return (
    <figure role="group" aria-label={title} className="border-line bg-card m-0 rounded-[14px] border px-4 py-3">
      <figcaption className="text-ink mb-2 text-[13px] font-semibold">{title}</figcaption>
      {empty ? (
        <p className="text-muted m-0 text-[12px]">No data in this window.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="block h-auto w-full">
          {children}
        </svg>
      )}
    </figure>
  );
}

const plotW = W - PAD.l - PAD.r;
const plotH = H - PAD.t - PAD.b;
const base = PAD.t + plotH;

function Axes({ max, fmt }: { max: number; fmt: (v: number) => string }) {
  return (
    <g className="text-muted" fontSize={9}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.l} x2={W - PAD.r} y1={base - f * plotH} y2={base - f * plotH} className="stroke-line" />
          <text x={PAD.l - 4} y={base - f * plotH + 3} textAnchor="end" fill="currentColor">
            {fmt(max * f)}
          </text>
        </g>
      ))}
    </g>
  );
}

function TimeInColumn({ data }: { data: ProjectKpis["timeInColumn"] }) {
  const vals = COLUMNS.map((c) => data[c] ?? 0);
  const max = Math.max(...vals) || 1;
  const slot = plotW / COLUMNS.length;
  return (
    <Chart title="Average time in column" empty={vals.every((v) => v === 0)}>
      <Axes max={max} fmt={(v) => days(v)} />
      {COLUMNS.map((c, i) => {
        const h = (vals[i]! / max) * plotH;
        return (
          <g key={c}>
            <rect
              data-column={c}
              data-height={h}
              x={PAD.l + i * slot + slot * 0.2}
              y={base - h}
              width={slot * 0.6}
              height={h}
              rx={4}
              className="fill-clay"
            >
              <title>{`${COLUMN_LABELS[c]}: ${days(data[c])}`}</title>
            </rect>
            <text x={PAD.l + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize={9} className="fill-muted">
              {COLUMN_LABELS[c]}
            </text>
          </g>
        );
      })}
    </Chart>
  );
}

function line(points: Array<[number, number]>) {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
}

function QualityChart({ data }: { data: ProjectKpis["quality"] }) {
  const x = (i: number) => PAD.l + (data.length < 2 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const series = [
    { name: "Pass rate", cls: "stroke-clay fill-clay", get: (q: ProjectKpis["quality"][number]) => q.passRate },
    { name: "Precision", cls: "stroke-jade fill-jade", get: (q: ProjectKpis["quality"][number]) => q.precision },
  ];
  return (
    <Chart title="Pass rate and precision over time" empty={!data.length}>
      <Axes max={1} fmt={pct} />
      {series.map((s) => {
        const pts = data.flatMap((q, i): Array<[number, number]> => {
          const v = s.get(q);
          return v === null ? [] : [[x(i), base - v * plotH]];
        });
        return (
          <g key={s.name} className={s.cls}>
            <path d={line(pts)} fill="none" strokeWidth={2} />
            {pts.map(([px, py], i) => (
              <circle key={i} cx={px} cy={py} r={3}>
                <title>{s.name}</title>
              </circle>
            ))}
          </g>
        );
      })}
      <g fontSize={9} className="fill-muted">
        <circle cx={PAD.l} cy={H - 10} r={3} className="fill-clay" />
        <text x={PAD.l + 7} y={H - 7}>Pass rate</text>
        <circle cx={PAD.l + 62} cy={H - 10} r={3} className="fill-jade" />
        <text x={PAD.l + 69} y={H - 7}>Precision</text>
      </g>
    </Chart>
  );
}

function Throughput({ data }: { data: ProjectKpis["throughput"] }) {
  const max = Math.max(1, ...data.map((d) => d.done));
  const slot = plotW / Math.max(data.length, 1);
  return (
    <Chart title="Throughput (done per day)" empty={!data.length}>
      <Axes max={max} fmt={(v) => String(Math.round(v))} />
      {data.map((d, i) => {
        const h = (d.done / max) * plotH;
        return (
          <rect key={d.date} x={PAD.l + i * slot + slot * 0.15} y={base - h} width={slot * 0.7} height={h} rx={3} className="fill-clay">
            <title>{`${d.date}: ${d.done}`}</title>
          </rect>
        );
      })}
    </Chart>
  );
}

function CycleTime({ data }: { data: ProjectKpis["cycleTime"] }) {
  const BINS = 6;
  const top = Math.max(0, ...data.map((d) => d.days));
  const size = top / BINS || 1;
  const counts = Array.from({ length: BINS }, () => 0);
  for (const d of data) counts[Math.min(BINS - 1, Math.floor(d.days / size))]!++;
  const max = Math.max(1, ...counts);
  const slot = plotW / BINS;
  return (
    <Chart title="Cycle time distribution" empty={!data.length}>
      <Axes max={max} fmt={(v) => String(Math.round(v))} />
      {counts.map((n, i) => {
        const h = (n / max) * plotH;
        return (
          <g key={i}>
            <rect x={PAD.l + i * slot + 1} y={base - h} width={slot - 2} height={h} rx={3} className="fill-clay">
              <title>{`${days(i * size)}–${days((i + 1) * size)}: ${n}`}</title>
            </rect>
            <text x={PAD.l + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize={9} className="fill-muted">
              {days(i * size)}
            </text>
          </g>
        );
      })}
    </Chart>
  );
}
