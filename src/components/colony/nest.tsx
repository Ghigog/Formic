"use client";

import { useEffect, useRef } from "react";
import {
  COLOR_UNLOCKS,
  SHAPE_UNLOCKS,
  XP_PER_LEVEL,
  nextUnlock,
  type BugShape,
} from "@/lib/colony/game";
import { useColony, type ColonyApi } from "./colony";
import { drawBug } from "./fx";

/** The ant hill at the end of the ambient bar. Opens the colony. */
export function NestButton() {
  const c = useColony();
  if (!c) return null;
  return (
    <button
      data-colony="nest"
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
  if (!c || !open) return null;

  const s = c.score;
  const next = nextUnlock(s.level);
  const nextText = next
    ? `Lv ${next.level} unlocks ${next.labels.join(" + ")} · ${(next.level - 1) * XP_PER_LEVEL - s.earned} XP to go`
    : "Every style unlocked";

  return (
    <>
      <div aria-hidden onClick={() => c.setColonyOpen(false)} className="fixed inset-0 z-[74]" />
      <div
        ref={panel}
        role="dialog"
        aria-label="Colony"
        className="border-line bg-card fixed right-4 bottom-16 z-[75] box-border flex w-[400px] max-w-[calc(100vw-32px)] origin-bottom-right flex-col gap-4 rounded-xl border p-5 shadow-[0_28px_56px_-24px_color-mix(in_srgb,var(--anthracite)_50%,transparent)]"
      >
        <div className="flex items-center gap-3">
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

        <div className="bg-panel flex flex-col gap-2 rounded-lg px-3 py-2.5">
          <span className="text-ink text-[12px] font-semibold">{nextText}</span>
          <span className="bg-line block h-1 overflow-hidden rounded-sm">
            <span
              className="bg-clay block h-1 transition-[width] duration-700"
              style={{ width: `${(s.intoLevel / XP_PER_LEVEL) * 100}%` }}
            />
          </span>
        </div>

        <div className="flex flex-col gap-2">
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

        <div className="flex flex-col gap-2">
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
