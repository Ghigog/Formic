"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatDuration } from "@/components/board/format-duration";
import { useColony } from "./colony";
import { useSound } from "./store";
import { cn } from "@/components/ui/cn";
import { COLUMNS, COLUMN_LABELS } from "@/lib/domain/status";
import type { ProjectKpis, KpiWindow } from "@/lib/kpi/compute";

const WINDOWS: Array<{ id: KpiWindow; label: string }> = [
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

/** Width a chart draws in until it has been measured (and in jsdom). */
const FALLBACK_W = 320;
const H = 140;
/** Caption size from design/DESIGN.md. */
const TEXT = 10;
const PAD = { l: 34, r: 8, t: 8 };
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const days = (v: number | null) => (v === null ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)} d`);

const COUNT_UP_MS = 900;
const DAY_MS = 86_400_000;

/** What the tooltip shows for one mark, and where the mark is in the drawing. */
/** `x` is the mark's centre and `r` half its width, so the tooltip clears it on either side. */
type Tip = { id: string; x: number; r: number; y: number; heading: string; lines: string[] };
type TipApi = {
  active: string | null;
  show: (tip: Tip) => void;
  hide: () => void;
};
const TipContext = createContext<TipApi>({ active: null, show: () => {}, hide: () => {} });

/** Handlers that make a chart mark show its tooltip on hover (mouse) and on tap, and dim when another mark is active. */
function useMark(tip: Tip) {
  const { active, show, hide } = useContext(TipContext);
  return {
    "data-tip-mark": "",
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") show(tip);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") hide();
    },
    onClick: () => show(tip),
    opacity: active === null || active === tip.id ? 1 : 0.35,
  };
}

/** A chart mark: `children` drawn in a group that carries the tooltip's handlers and the dimming. */
function Mark({ tip, children }: { tip: Tip; children: React.ReactNode }) {
  const { opacity, ...handlers } = useMark(tip);
  return (
    <g {...handlers} opacity={opacity}>
      {children}
    </g>
  );
}

/** How far the reveal animation has got, 0 to 1; charts and tiles read it. */
const Progress = createContext(1);

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
            <Tile label="Precision" value={pct(data.tiles.precision)} className="max-md:col-span-2" />
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

/** `padB` is the room under the plot for column labels or the legend. */
function Chart({ title, empty, padB = 22, children }: { title: string; empty: boolean; padB?: number; children: React.ReactNode }) {
  const p = useContext(Progress);
  const [tip, setTip] = useState<Tip | null>(null);
  // A tap elsewhere or Escape closes the tooltip, as InfoTip does.
  useEffect(() => {
    if (!tip) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-tip-mark]")) setTip(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setTip(null);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [tip]);
  const api: TipApi = { active: tip?.id ?? null, show: setTip, hide: () => setTip(null) };
  const svg = useRef<SVGSVGElement>(null);
  // 1 viewBox unit = 1 CSS px, so text keeps its size at any width.
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setMeasured(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);
  const geo = geometry(measured || FALLBACK_W, padB);
  // Keep the card inside the chart at either edge: flipping at the midpoint is not enough
  // when the card is wider than the room on that side (a 390px screen).
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const flip = tip.x > geo.W / 2;
    const left = flip ? tip.x - tip.r - 10 - w : tip.x + tip.r + 10;
    el.style.left = `${Math.max(0, Math.min(left, geo.W - w))}px`;
    el.style.transform = "none";
  }, [tip, geo.W]);
  return (
    <figure role="group" aria-label={title} className="border-line bg-card relative m-0 rounded-xl border px-4 py-3">
      <figcaption className="text-ink mb-2 text-[12px] font-semibold">{title}</figcaption>
      {empty ? (
        <p className="text-muted m-0 text-[12px]">No data in this window.</p>
      ) : (
        <div className="relative">
          <svg ref={svg} viewBox={`0 0 ${geo.W} ${H}`} role="img" aria-label={title} className="block h-auto w-full">
            <g
              data-progress={p}
              style={p < 1 ? { opacity: p, transform: `scaleY(${p})`, transformOrigin: `0px ${geo.base}px` } : undefined}
            >
              <Geometry.Provider value={geo}>
                <TipContext.Provider value={api}>{children}</TipContext.Provider>
              </Geometry.Provider>
            </g>
          </svg>
          {tip && (
            <div
              ref={card}
              role="tooltip"
              className="bg-anthracite text-on-anthracite pointer-events-none absolute z-10 flex flex-col gap-0.5 rounded-lg px-2.5 py-2 whitespace-nowrap shadow-[0_10px_20px_-12px_color-mix(in_srgb,var(--anthracite)_60%,transparent)]"
              style={{
                left: tip.x + (tip.x > geo.W / 2 ? -tip.r : tip.r),
                top: Math.max(0, tip.y),
                transform: tip.x > geo.W / 2 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
              }}
            >
              <span className="text-[12px] font-semibold">{tip.heading}</span>
              {tip.lines.map((l) => (
                <span key={l} className="text-line-dashed font-mono text-[10px]">
                  {l}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

type Geo = { W: number; plotW: number; plotH: number; base: number };
const Geometry = createContext<Geo>(geometry(FALLBACK_W, 22));

/** The drawing's measurements for a figure `W` units (CSS px) wide with `padB` units under the plot. */
function geometry(W: number, padB: number): Geo {
  const plotH = H - PAD.t - padB;
  return { W, plotW: W - PAD.l - PAD.r, plotH, base: PAD.t + plotH };
}

function Axes({ max, fmt }: { max: number; fmt: (v: number) => string }) {
  const { W, plotH, base } = useContext(Geometry);
  return (
    <g className="text-muted" fontSize={TEXT}>
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

const SHOWN_COLUMNS = COLUMNS.filter((c) => c !== "done");

function TimeInColumn({ data }: { data: ProjectKpis["timeInColumn"] }) {
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

function QualityChart({ data }: { data: ProjectKpis["quality"] }) {
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
    { name: "Precision", cls: "stroke-jade fill-jade", get: (q: ProjectKpis["quality"][number]) => q.precision },
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
    lines: [`Pass rate ${pct(q.passRate)} · Precision ${pct(q.precision)}`, `${q.done} ${q.done === 1 ? "ticket" : "tickets"} reached Done`],
  };
  const { opacity, ...handlers } = useMark(tip);
  return <circle cx={cx} cy={cy} r={3} opacity={opacity} {...handlers} />;
}

/** "Tue, Nov 18" for a YYYY-MM-DD day. */
function dateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function Throughput({ data }: { data: ProjectKpis["throughput"] }) {
  return (
    <Chart title="Throughput (done per day)" empty={!data.length}>
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

function CycleTime({ data }: { data: ProjectKpis["cycleTime"] }) {
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
