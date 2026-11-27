"use client";

import { useContext } from "react";
import { formatDuration } from "@/components/board/format-duration";
import { COLUMNS, COLUMN_LABELS } from "@/lib/domain/status";
import type { ProjectKpis } from "@/lib/kpi/compute";
import { Axes, Chart, Geometry, H, Mark, PAD, TEXT, days, pct, useMark, type Tip } from "./kpi-chart";

const DAY_MS = 86_400_000;

const SHOWN_COLUMNS = COLUMNS.filter((c) => c !== "done");

export function TimeInColumn({ data }: { data: ProjectKpis["timeInColumn"] }) {
  const vals = SHOWN_COLUMNS.map((c) => (data[c]?.avgMs ?? 0) / DAY_MS);
  const max = Math.max(...vals) || 1;
  return (
    <Chart title="Average time in column" empty={SHOWN_COLUMNS.every((c) => !data[c])} padB={TWO_LINE_PAD}>
      <Axes max={max} fmt={(v) => days(v)} />
      <ColumnBars vals={vals} max={max} data={data} />
    </Chart>
  );
}

function ColumnBars({ vals, max, data }: { vals: number[]; max: number; data: ProjectKpis["timeInColumn"] }) {
  const { plotW, plotH, base } = useContext(Geometry);
  const slot = plotW / SHOWN_COLUMNS.length;
  return (
    <>
      {SHOWN_COLUMNS.map((c, i) => {
        const h = (vals[i]! / max) * plotH;
        const t = data[c];
        const cx = PAD.l + i * slot + slot / 2;
        const tip: Tip = {
          id: c,
          x: cx,
          r: slot * 0.3,
          y: base - h,
          heading: COLUMN_LABELS[c],
          lines: t
            ? [`avg ${formatDuration(t.avgMs)} · total ${formatDuration(t.totalMs)}`, `${t.tickets} ${t.tickets === 1 ? "ticket" : "tickets"}`]
            : [`No ticket has left ${COLUMN_LABELS[c]} in this window`],
        };
        return (
          <Mark key={c} tip={tip}>
            {t ? (
              <rect
                data-column={c}
                data-height={h}
                x={PAD.l + i * slot + slot * 0.2}
                y={base - h}
                width={slot * 0.6}
                height={h}
                rx={4}
                className="fill-clay"
              />
            ) : (
              <text data-column={c} data-height={0} x={cx} y={base - 4} textAnchor="middle" fontSize={TEXT} className="fill-muted">
                –
              </text>
            )}
            {/* The whole slot takes the pointer, so a short bar or a tap is easy to hit. */}
            <rect x={PAD.l + i * slot} y={PAD.t} width={slot} height={plotH} fill="transparent" />
            <SlotLabel x={cx} slot={slot} text={COLUMN_LABELS[c]} />
          </Mark>
        );
      })}
    </>
  );
}

/** Room for two lines of caption text under the plot. */
const TWO_LINE_PAD = 34;
/** Rough width of one caption character, in px. */
const CHAR_W = 6;

/** A label centred under a slot; a two-word label wider than the slot goes on two lines. */
function SlotLabel({ x, slot, text }: { x: number; slot: number; text: string }) {
  const words = text.split(" ");
  const wrap = words.length === 2 && text.length * CHAR_W > slot - 4;
  return (
    <text x={x} y={H - (wrap ? 20 : 8)} textAnchor="middle" fontSize={TEXT} className="fill-muted">
      {wrap
        ? words.map((w, i) => (
            <tspan key={w} x={x} dy={i ? 12 : 0}>
              {w}
            </tspan>
          ))
        : text}
    </text>
  );
}

function line(points: Array<[number, number]>) {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
}

export function QualityChart({ data }: { data: ProjectKpis["quality"] }) {
  return (
    <Chart title="Pass rate and precision over time" empty={!data.length}>
      <QualityPlot data={data} />
    </Chart>
  );
}

function QualityPlot({ data }: { data: ProjectKpis["quality"] }) {
  const { plotW, plotH, base } = useContext(Geometry);
  const x = (i: number) => PAD.l + (data.length < 2 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const series = [
    { name: "Pass rate", cls: "stroke-clay fill-clay", get: (q: ProjectKpis["quality"][number]) => q.passRate },
    { name: "Precision", cls: "stroke-jade fill-jade", get: (q: ProjectKpis["quality"][number]) => q.unchangedAfterSpec },
  ];
  return (
    <>
      <Axes max={1} fmt={pct} />
      {series.map((s) => {
        const idx: number[] = [];
        const pts = data.flatMap((q, i): Array<[number, number]> => {
          const v = s.get(q);
          if (v === null) return [];
          idx.push(i);
          return [[x(i), base - v * plotH]];
        });
        return (
          <g key={s.name} className={s.cls}>
            <path d={line(pts)} fill="none" strokeWidth={2} />
            {pts.map(([px, py], i) => (
              <QualityPoint key={i} cx={px} cy={py} name={s.name} q={data[idx[i]!]!} />
            ))}
          </g>
        );
      })}
      <g fontSize={TEXT} className="fill-muted">
        <circle cx={PAD.l} cy={H - 10} r={3} className="fill-clay" />
        <text x={PAD.l + 7} y={H - 7}>Pass rate</text>
        <circle cx={PAD.l + 70} cy={H - 10} r={3} className="fill-jade" />
        <text x={PAD.l + 77} y={H - 7}>Precision</text>
      </g>
    </>
  );
}

function QualityPoint({ cx, cy, name, q }: { cx: number; cy: number; name: string; q: ProjectKpis["quality"][number] }) {
  const tip: Tip = {
    id: `${name}-${q.date}`,
    x: cx,
    r: 3,
    y: cy,
    heading: dateLabel(q.date),
    lines: [`Pass rate ${pct(q.passRate)} · Precision ${pct(q.unchangedAfterSpec)}`, `${q.done} ${q.done === 1 ? "ticket" : "tickets"} reached Done`],
  };
  const { opacity, ...handlers } = useMark(tip);
  return <circle cx={cx} cy={cy} r={3} opacity={opacity} {...handlers} />;
}

/** "Tue, Nov 18" for a YYYY-MM-DD day. */
function dateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function Throughput({ data }: { data: ProjectKpis["throughput"] }) {
  return (
    <Chart title="Throughput (done per day)" empty={!data.some((d) => d.done)}>
      <ThroughputBars data={data} />
    </Chart>
  );
}

function ThroughputBars({ data }: { data: ProjectKpis["throughput"] }) {
  const { plotW, plotH, base } = useContext(Geometry);
  const max = Math.max(1, ...data.map((d) => d.done));
  const slot = plotW / Math.max(data.length, 1);
  return (
    <>
      <Axes max={max} fmt={(v) => String(Math.round(v))} />
      {data.map((d, i) => {
        const h = (d.done / max) * plotH;
        return (
          <Mark key={d.date} tip={{ id: d.date, x: PAD.l + i * slot + slot / 2, r: slot * 0.35, y: base - h, heading: dateLabel(d.date), lines: [`${d.done} ${d.done === 1 ? "ticket" : "tickets"} done`] }}>
            <rect x={PAD.l + i * slot + slot * 0.15} y={base - h} width={slot * 0.7} height={h} rx={3} className="fill-clay" />
          </Mark>
        );
      })}
    </>
  );
}

export function CycleTime({ data }: { data: ProjectKpis["cycleTime"] }) {
  return (
    <Chart title="Cycle time distribution" empty={!data.length}>
      <CycleBars data={data} />
    </Chart>
  );
}

function CycleBars({ data }: { data: ProjectKpis["cycleTime"] }) {
  const { plotW, plotH, base } = useContext(Geometry);
  const BINS = 6;
  const top = Math.max(0, ...data.map((d) => d.days));
  const size = top / BINS || 1;
  const counts = Array.from({ length: BINS }, () => 0);
  for (const d of data) counts[Math.min(BINS - 1, Math.floor(d.days / size))]!++;
  const max = Math.max(1, ...counts);
  const slot = plotW / BINS;
  return (
    <>
      <Axes max={max} fmt={(v) => String(Math.round(v))} />
      {counts.map((n, i) => {
        const h = (n / max) * plotH;
        return (
          <Mark key={i} tip={{ id: String(i), x: PAD.l + i * slot + slot / 2, r: slot / 2 - 1, y: base - h, heading: `${days(i * size)}–${days((i + 1) * size)}`, lines: [`${n} ${n === 1 ? "ticket" : "tickets"}`] }}>
            <rect x={PAD.l + i * slot + 1} y={base - h} width={slot - 2} height={h} rx={3} className="fill-clay" />
            <text x={PAD.l + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize={TEXT} className="fill-muted">
              {days(i * size)}
            </text>
          </Mark>
        );
      })}
    </>
  );
}
