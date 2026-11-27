"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TicketRef } from "@/lib/kpi/compute";

/** Width a chart draws in until it has been measured (and in jsdom). */
export const FALLBACK_W = 320;
export const H = 140;
/** Caption size from design/DESIGN.md. */
export const TEXT = 10;
export const PAD = { l: 34, r: 8, t: 8 };
export const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
export const days = (v: number | null) => (v === null ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)} d`);

/** What the tooltip shows for one mark, and where the mark is in the drawing. */
/** `x` is the mark's centre and `r` half its width, so the tooltip clears it on either side. */
/** `tickets` are the tickets behind the mark, listed under the chart when it is opened. */
export type Tip = { id: string; x: number; r: number; y: number; heading: string; lines: string[]; tickets?: TicketRef[]; label?: string };
type TipApi = {
  active: string | null;
  show: (tip: Tip) => void;
  hide: () => void;
  open: (tip: Tip) => void;
};
export const TipContext = createContext<TipApi>({ active: null, show: () => {}, hide: () => {}, open: () => {} });

/** Handlers that make a chart mark show its tooltip on hover (mouse) and on tap, and dim when another mark is active. */
export function useMark(tip: Tip) {
  const { active, show, hide, open } = useContext(TipContext);
  return {
    "data-tip-mark": "",
    tabIndex: 0,
    role: "button" as const,
    "aria-label": tip.label ?? [tip.heading, ...tip.lines].join(", "),
    className: "outline-none focus-visible:outline-2 focus-visible:outline-clay",
    onFocus: () => show(tip),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      open(tip);
    },
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") show(tip);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") hide();
    },
    onClick: () => open(tip),
    opacity: active === null || active === tip.id ? 1 : 0.35,
  };
}

/** A chart mark: `children` drawn in a group that carries the tooltip's handlers and the dimming. */
export function Mark({ tip, children }: { tip: Tip; children: React.ReactNode }) {
  const { opacity, ...handlers } = useMark(tip);
  return (
    <g {...handlers} opacity={opacity}>
      {children}
    </g>
  );
}

/**
 * A bar that rises with the reveal: each bar's scaleY follows `Progress`, staggered by `index`
 * of `count`, with the Timeline mound's slight overshoot. At progress 1 it is at its end state.
 */
export function riseScale(p: number, index: number, count: number): number {
  const t = Math.min(1, Math.max(0, (p - (index / Math.max(count, 1)) * 0.5) / 0.5));
  return t < 0.7 ? (t / 0.7) * 1.15 : 1.15 - 0.15 * ((t - 0.7) / 0.3);
}

/** A mound: rounded top (rx half the width), flat base. */
export function Mound({ x, w, h, index, count, className, style, ...rest }: { x: number; w: number; h: number; index: number; count: number; className?: string; style?: React.CSSProperties } & Record<string, unknown>) {
  const p = useContext(Progress);
  const { base } = useContext(Geometry);
  const ry = Math.min(w / 2, h);
  const d = `M${x} ${base}V${base - h + ry}A${w / 2} ${ry} 0 0 1 ${x + w} ${base - h + ry}V${base}Z`;
  return (
    <path
      d={d}
      data-rx={w / 2}
      className={className}
      style={p < 1 ? { ...style, transform: `scaleY(${riseScale(p, index, count)})`, transformOrigin: `0px ${base}px` } : style}
      {...rest}
    />
  );
}

/** How far the reveal animation has got, 0 to 1; charts and tiles read it. */
export const Progress = createContext(1);

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** `padB` is the room under the plot for column labels or the legend. */
export function Chart({
  title,
  empty,
  padB = 22,
  onOpenTicket,
  children,
}: {
  title: string;
  empty: boolean;
  padB?: number;
  onOpenTicket?: (ticketId: string) => void;
  children: React.ReactNode;
}) {
  const p = useContext(Progress);
  const [tip, setTip] = useState<Tip | null>(null);
  // The tickets behind the mark that was opened, listed under the chart.
  const [list, setList] = useState<Tip | null>(null);
  // A tap elsewhere or Escape closes the tooltip and the list, as InfoTip does.
  useEffect(() => {
    if (!tip && !list) return;
    const close = () => {
      setTip(null);
      setList(null);
    };
    const away = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-tip-mark], [data-tip-list]")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [tip, list]);
  const api: TipApi = {
    active: tip?.id ?? null,
    show: setTip,
    hide: () => setTip(null),
    open: (t) => {
      setTip(t);
      setList(t.tickets?.length ? t : null);
    },
  };
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
              style={p < 1 ? { opacity: p } : undefined}
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
          {list && (
            <div
              data-tip-list
              role="group"
              aria-label={`Tickets on ${list.heading}`}
              className="bg-anthracite text-on-anthracite mt-2 flex flex-col gap-0.5 rounded-lg px-2.5 py-2"
            >
              <span className="text-[12px] font-semibold">{list.heading}</span>
              {list.tickets!.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenTicket?.(t.id)}
                  className="text-line-dashed focus-visible:outline-clay flex min-h-8 items-baseline gap-2 text-left text-[12px] hover:underline focus-visible:outline-2"
                >
                  <span className="font-mono text-[10px]">{t.key}</span>
                  <span className="truncate">{t.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

export type Geo = { W: number; plotW: number; plotH: number; base: number };
export const Geometry = createContext<Geo>(geometry(FALLBACK_W, 22));

/** The drawing's measurements for a figure `W` units (CSS px) wide with `padB` units under the plot. */
export function geometry(W: number, padB: number): Geo {
  const plotH = H - PAD.t - padB;
  return { W, plotW: W - PAD.l - PAD.r, plotH, base: PAD.t + plotH };
}

export function Axes({ max, fmt }: { max: number; fmt: (v: number) => string }) {
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

