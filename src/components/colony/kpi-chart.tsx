"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

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
export type Tip = { id: string; x: number; r: number; y: number; heading: string; lines: string[] };
type TipApi = {
  active: string | null;
  show: (tip: Tip) => void;
  hide: () => void;
};
export const TipContext = createContext<TipApi>({ active: null, show: () => {}, hide: () => {} });

/** Handlers that make a chart mark show its tooltip on hover (mouse) and on tap, and dim when another mark is active. */
export function useMark(tip: Tip) {
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
export function Mark({ tip, children }: { tip: Tip; children: React.ReactNode }) {
  const { opacity, ...handlers } = useMark(tip);
  return (
    <g {...handlers} opacity={opacity}>
      {children}
    </g>
  );
}

/** How far the reveal animation has got, 0 to 1; charts and tiles read it. */
export const Progress = createContext(1);

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** `padB` is the room under the plot for column labels or the legend. */
export function Chart({ title, empty, padB = 22, children }: { title: string; empty: boolean; padB?: number; children: React.ReactNode }) {
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

