"use client";

import { AutoTour } from "@/components/onboarding/tour";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  COLOR_UNLOCKS,
  SHAPE_UNLOCKS,
  XP_PER_LEVEL,
  nextUnlock,
  type BugShape,
} from "@/lib/colony/game";
import { useColony, type ColonyApi } from "./colony";
import { drawBug } from "./fx";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { QUEEN_CARRY_EVENT, edgeScrollSpeed, queenPoint, nextSway, legWiggle, MAX_SWAY_DEG, type QueenCarryDetail } from "./queen-carry";
import { QueenIcon } from "./queen-icon";
import { ColonyPanel } from "./colony-panel";
import { InfoTip } from "./info-tip";

/** The ant hill at the end of the ambient bar. Opens the colony. */
export function NestButton() {
  const c = useColony();
  if (!c) return null;
  return (
    <button
      data-colony="nest"
      data-tour="colony"
      type="button"
      onClick={() => c.setColonyOpen(!c.colonyOpen)}
      aria-label="Open colony: levels and bug styles"
      aria-expanded={c.colonyOpen}
      className="hover:border-drawer-line -mr-2 inline-flex h-9 w-10 items-center max-md:size-11 justify-center rounded-lg border border-transparent hover:bg-drawer-hover"
    >
      <svg width="24" height="14" viewBox="0 0 24 14" fill="none" aria-hidden="true">
        <path d="M1 13.5C3.5 5 7.5 1.5 12 1.5S20.5 5 23 13.5Z" fill="var(--drawer-line)" stroke="var(--text-muted)" />
        <ellipse cx="12" cy="11" rx="2.6" ry="2.1" fill="var(--nest-hole)" />
      </svg>
    </button>
  );
}

function BugPreview({ shape, locked, on, c }: { shape: BugShape; locked: boolean; on: boolean; c: ColonyApi }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    let raf = 0;
    const paint = (t: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      drawBug(
        ctx,
        cv.width / 2,
        cv.height / 2 + 2,
        cv.width / 20,
        on && !c.fx.reducedMotion ? (t / 1000) * 0.12 : 0.26,
        shape,
        locked ? "var(--border-dashed)" : c.bugHex,
        locked ? "var(--border-dashed)" : undefined,
      );
      if (on && !c.fx.reducedMotion) raf = requestAnimationFrame(paint);
    };
    paint(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [shape, locked, on, c.bugHex, c.fx]);
  return <canvas ref={ref} width={80} height={80} className="size-10" aria-hidden />;
}

/** The Queen, drawn with the chosen shape and colour at 10x. Also the drag image. */
function QueenBug({ c, className }: { c: ColonyApi; className: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    drawBug(ctx, cv.width / 2, cv.height / 2 + 2, 10, 0.26, c.shape, c.bugHex);
  }, [c.shape, c.bugHex]);
  return <canvas ref={ref} width={200} height={200} className={className} aria-hidden />;
}

/**
 * The Queen under the finger. Each frame her legs sway against the pointer's
 * horizontal travel, on top of a constant wiggle, and her body leans the same way.
 * Reduced motion draws her at rest.
 */
function DragQueen({ c, x }: { c: ColonyApi; x: { current: number } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    let raf = 0;
    let sway = 0;
    let lastX = x.current;
    const paint = (now: number) => {
      sway = nextSway(sway, x.current - lastX);
      lastX = x.current;
      const legs = (sway / MAX_SWAY_DEG) * 1.6 + legWiggle(now);
      cv.style.transform = `rotate(${sway}deg)`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      drawBug(ctx, cv.width / 2, cv.height / 2 + 2, 10, 0.26, c.shape, c.bugHex, undefined, { legSwing: legs });
      raf = requestAnimationFrame(paint);
    };
    if (c.fx.reducedMotion) {
      cv.style.transform = "";
      drawBug(ctx, cv.width / 2, cv.height / 2 + 2, 10, 0.26, c.shape, c.bugHex);
    } else {
      raf = requestAnimationFrame(paint);
    }
    return () => cancelAnimationFrame(raf);
  }, [c.shape, c.bugHex, c.fx, c.fx.reducedMotion, x]);
  return <canvas ref={ref} width={200} height={200} className="size-14" aria-hidden />;
}

/** How far the pointer travels, in px, between two leg-ticks of a carried Queen. */
const SKITTER_EVERY = 28;

/**
 * Unspent Queens, and one to drag onto a card. A pointer drag, like the rest
 * of the board's, not native HTML5 drag: the board's drag library owns
 * pointer events on its own cards, and a drop here is found with
 * `elementFromPoint` on the card's `data-tid`.
 */
function QueenTray({ c, onDragging }: { c: ColonyApi; onDragging: (on: boolean) => void }) {
  const [unspent, setUnspent] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pointerX = useRef(0);

  useEffect(() => {
    let live = true;
    fetch("/api/queens")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { unspent: number } | null) => live && body && setUnspent(body.unspent))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [c.score.level]);

  const place = async (cardId: string) => {
    try {
      const res = await fetch("/api/queens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId }),
      });
      const body = (await res.json().catch(() => ({}))) as { unspent?: number; error?: string };
      if (!res.ok) {
        c.sfx("reject");
        return setError(body.error ?? "Could not place the Queen.");
      }
      setError(null);
      if (typeof body.unspent === "number") setUnspent(body.unspent);
    } catch {
      c.sfx("reject");
      setError("Could not place the Queen.");
    }
  };

  const start = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pointerType = e.pointerType;
    setDrag(queenPoint(e.clientX, e.clientY, pointerType));
    pointerX.current = e.clientX;
    onDragging(true);
    window.dispatchEvent(new CustomEvent<QueenCarryDetail>(QUEEN_CARRY_EVENT, { detail: { on: true } }));
    let pointerY = e.clientY;
    let tick = queenPoint(e.clientX, e.clientY, pointerType);
    let ticks = 0;
    const move = (m: PointerEvent) => {
      pointerX.current = m.clientX;
      pointerY = m.clientY;
      // A leg-tick for every stretch of ground covered, not for every event.
      const q = queenPoint(m.clientX, m.clientY, pointerType);
      if (Math.hypot(q.x - tick.x, q.y - tick.y) >= SKITTER_EVERY) {
        tick = q;
        c.sfx("skitter", ticks++ % 3);
      }
      setDrag(q);
    };
    // Scroll the visible column's list while she is held near its top or bottom edge.
    let scrollRaf = 0;
    const scroll = () => {
      const px = pointerX.current;
      const list = [...document.querySelectorAll<HTMLElement>("[data-column-list]")].find((l) => {
        const r = l.getBoundingClientRect();
        return px >= r.left && px <= r.right;
      });
      if (list) {
        const r = list.getBoundingClientRect();
        list.scrollTop += edgeScrollSpeed(pointerY, r.top, r.bottom);
      }
      scrollRaf = requestAnimationFrame(scroll);
    };
    scrollRaf = requestAnimationFrame(scroll);
    const end = (u: PointerEvent) => {
      cancelAnimationFrame(scrollRaf);
      window.dispatchEvent(new CustomEvent<QueenCarryDetail>(QUEEN_CARRY_EVENT, { detail: { on: false } }));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrag(null);
      onDragging(false);
      // She is drawn below a touch, but lands where the finger points.
      const q = { x: u.clientX, y: u.clientY };
      const id = u.type === "pointerup" ? document.elementFromPoint(q.x, q.y)?.closest<HTMLElement>("[data-tid]")?.dataset.tid : null;
      if (id) {
        // The smush is on the drop, not on the answer, so it feels immediate.
        c.sfx("squash");
        if (!c.fx.reducedMotion) c.fx.squash(q.x, q.y, () => {});
        void place(id);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const count = unspent ?? 0;
  return (
    <div className="bg-panel relative flex items-center gap-3 rounded-lg px-3 py-2.5">
      <span className="text-clay inline-flex shrink-0" data-queen-icon>
        <QueenIcon size={22} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ink flex items-center gap-1.5 text-[12px] font-semibold">
          <span>
            Queens <span data-queen-count>{count}</span>
          </span>
          <InfoTip label="How Queens work">
            Drop a Queen on a ticket and the ants work through every ticket it needs, until that ticket is done. Each
            level earns one more; a placed Queen is spent.
          </InfoTip>
        </span>
        <span className="text-muted text-[11px]">Unlock a queen with each level</span>
        {error && (
          <span role="alert" className="text-log-error text-[11px]">
            {error}
          </span>
        )}
      </div>
      {count > 0 && (
        <button
          type="button"
          data-queen-drag
          aria-label="Drag a Queen onto a card"
          onPointerDown={start}
          className="border-line bg-card inline-flex size-12 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg border active:cursor-grabbing"
        >
          <QueenBug c={c} className="size-10" />
        </button>
      )}
      {drag &&
        // Portalled out of the panel, which is hidden on a phone while she is carried.
        createPortal(
          <div
            data-queen-image
            aria-hidden
            className="pointer-events-none fixed z-[90] -translate-x-1/2 -translate-y-1/2"
            style={{ left: drag.x, top: drag.y }}
          >
            <DragQueen c={c} x={pointerX} />
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Levels and bug styles: what the colony has earned and what it can wear. */
export function ColonyPopover() {
  const c = useColony();
  const panel = useRef<HTMLDivElement>(null);
  const open = !!c?.colonyOpen;
  useEffect(() => {
    if (!open || !c) return;
    panel.current?.animate(
      [
        { opacity: 0, transform: "translateY(12px) scale(0.96)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 260, easing: "cubic-bezier(.2,.9,.3,1.2)" },
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") c.setColonyOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const [carrying, setCarrying] = useState(false);
  const isMobile = useMediaQuery("(max-width: 767px)");
  if (!c || !open) return null;

  const s = c.score;
  const next = nextUnlock(s.level);
  const nextText = next
    ? `Lv ${next.level} unlocks ${next.labels.join(" + ")} · ${(next.level - 1) * XP_PER_LEVEL - s.earned} XP to go`
    : "Everything unlocked";

  return (
    <>
      <div
        aria-hidden
        onClick={() => c.setColonyOpen(false)}
        className={`fixed inset-0 z-[74] ${carrying ? "pointer-events-none" : ""} ${carrying && isMobile ? "invisible" : ""}`}
      />
      <div
        ref={panel}
        role="dialog"
        aria-label="Colony"
        className={`border-line bg-card fixed right-4 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-[75] box-border flex max-h-[calc(100dvh-5rem)] w-[400px] overflow-y-auto overscroll-contain max-w-[calc(100vw-32px)] origin-bottom-right flex-col gap-4 rounded-xl border p-5 shadow-[0_28px_56px_-24px_color-mix(in_srgb,var(--anthracite)_50%,transparent)] ${carrying ? "pointer-events-none" : ""} ${carrying && isMobile ? "invisible" : ""}`}
      >
        <AutoTour id="colony" delay={800} />
        <div data-tour="colony-rank" className="flex items-center gap-3">
          <span className="bg-anthracite text-cream inline-flex size-[42px] shrink-0 flex-col items-center justify-center gap-px [clip-path:polygon(10px_0,calc(100%-10px)_0,100%_10px,100%_calc(100%-10px),calc(100%-10px)_100%,10px_100%,0_calc(100%-10px),0_10px)]">
            <span className="text-drawer-muted font-mono text-[8px] tracking-[0.1em]">LV</span>
            <span className="font-serif text-[18px] leading-none font-semibold">{s.level}</span>
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="text-ink font-serif text-[20px] leading-[1.1] font-semibold">{s.rank}</span>
            <span className="text-muted font-mono text-[10px]">
              {s.earned.toLocaleString("en-US")} XP earned · {s.intoLevel}/{XP_PER_LEVEL} this level
            </span>
          </div>
          <button
            type="button"
            aria-label="Close colony"
            onClick={() => c.setColonyOpen(false)}
            className="border-line bg-cream inline-flex size-8 shrink-0 items-center justify-center rounded-lg border"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="var(--text)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <QueenTray c={c} onDragging={setCarrying} />

        <ColonyPanel level={s.level} />

        <div data-tour="colony-next" className="bg-panel flex flex-col gap-2 rounded-lg px-3 py-2.5">
          <span className="text-ink text-[12px] font-semibold">{nextText}</span>
          <span className="bg-line block h-1 overflow-hidden rounded-sm">
            <span
              className="bg-clay block h-1 transition-[width] duration-700"
              style={{ width: `${next ? (s.intoLevel / XP_PER_LEVEL) * 100 : 100}%` }}
            />
          </span>
        </div>

        <div data-tour="colony-shapes" className="flex flex-col gap-2">
          <h3 className="text-ink m-0 text-[11px] font-semibold tracking-[0.1em] uppercase">Bug shape</h3>
          <div className="grid grid-cols-6 gap-1.5">
            {SHAPE_UNLOCKS.map((u) => {
              const locked = s.level < u.lv;
              const on = c.shape === u.key;
              return (
                <button
                  key={u.key}
                  type="button"
                  onClick={(e) => c.tryStyle({ shape: u.key }, e.currentTarget)}
                  aria-label={locked ? `${u.label}, unlocks at level ${u.lv}` : `Use ${u.label} bugs`}
                  aria-pressed={on}
                  className="flex min-w-0 flex-col items-center gap-0.5 rounded-lg border-[1.5px] px-0.5 py-1.5"
                  style={{
                    borderColor: on ? "var(--terracotta)" : "var(--border)",
                    background: on ? "var(--epic-chip)" : locked ? "var(--nested-muted)" : "var(--card)",
                    cursor: locked ? "not-allowed" : "pointer",
                  }}
                >
                  <BugPreview shape={u.key} locked={locked} on={on && !locked} c={c} />
                  <span className={`text-center text-[10px] leading-tight font-semibold ${locked ? "text-muted" : "text-ink"}`}>
                    {u.label}
                  </span>
                  <span className="text-muted min-h-3 font-mono text-[9px]">
                    {locked ? `Lv ${u.lv}` : on ? "Equipped" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div data-tour="colony-colours" className="flex flex-col gap-2">
          <h3 className="text-ink m-0 text-[11px] font-semibold tracking-[0.1em] uppercase">Bug colour</h3>
          <div className="grid grid-cols-6 gap-1.5">
            {COLOR_UNLOCKS.map((u) => {
              const locked = s.level < u.lv;
              const on = c.color === u.key;
              return (
                <button
                  key={u.key}
                  type="button"
                  onClick={(e) => c.tryStyle({ color: u.key }, e.currentTarget)}
                  aria-label={locked ? `${u.label}, unlocks at level ${u.lv}` : `Use ${u.label} bugs`}
                  aria-pressed={on}
                  className="bg-card flex min-w-0 flex-col items-center gap-1 rounded-lg border-[1.5px] px-0.5 py-1.5"
                  style={{ borderColor: on ? "var(--terracotta)" : "transparent", cursor: locked ? "not-allowed" : "pointer" }}
                >
                  <span className="relative inline-flex size-[26px] items-center justify-center">
                    <span
                      className="absolute inset-0 [clip-path:polygon(8px_0,calc(100%-8px)_0,100%_8px,100%_calc(100%-8px),calc(100%-8px)_100%,8px_100%,0_calc(100%-8px),0_8px)]"
                      style={{ background: u.hex, opacity: locked ? 0.28 : 1 }}
                    />
                    {locked && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="relative">
                        <rect x="2" y="4.5" width="6" height="4.5" rx="1" fill="var(--text)" />
                        <path d="M3.3 4.5V3.3a1.7 1.7 0 0 1 3.4 0v1.2" stroke="var(--text)" strokeWidth="1" />
                      </svg>
                    )}
                  </span>
                  <span className="text-muted font-mono text-[9px] whitespace-nowrap">
                    {locked ? `Lv ${u.lv}` : u.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <p className="text-muted m-0 text-[11px] leading-[1.5]">
          Levels come from points earned, so a bug penalty lowers your score but never your level. Pick a style to
          test-squash it.
        </p>
      </div>
    </>
  );
}
