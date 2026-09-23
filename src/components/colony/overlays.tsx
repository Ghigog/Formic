"use client";

import { useEffect, useRef } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { useColony } from "./colony";
import { centerOf } from "./fx";

/** Level-ups and firsts: a pill under the header for a few seconds. */
export function ColonyToast() {
  const c = useColony();
  const ref = useRef<HTMLDivElement>(null);
  const key = c?.toast?.key;
  useEffect(() => {
    if (!key || c?.fx.reducedMotion) return;
    ref.current?.animate(
      [
        { opacity: 0, transform: "translateY(-10px) scale(0.96)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 280, easing: "cubic-bezier(.2,.9,.3,1.25)" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!c?.toast) return null;
  return (
    <div className="pointer-events-none fixed top-[76px] right-0 left-0 z-[70] flex justify-center">
      <div
        ref={ref}
        role="status"
        className="bg-anthracite text-cream flex items-center gap-2.5 rounded-full py-2.5 pr-4 pl-2.5 text-[12px] font-semibold shadow-[0_16px_32px_-14px_color-mix(in_srgb,var(--anthracite)_55%,transparent)]"
      >
        <span className="oct bg-clay text-anthracite inline-flex size-[22px] items-center justify-center font-mono text-[10px]">
          {c.score.level}
        </span>
        {c.toast.text}
      </div>
    </div>
  );
}

/** An epic's last ticket merged: the coin, the bonus, the way to its showcase. */
export function EpicWinDialog({ onShowcase }: { onShowcase?: (epic: BoardCard) => void }) {
  const c = useColony();
  const card = useRef<HTMLDivElement>(null);
  const coin = useRef<HTMLSpanElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const win = c?.win;
  useEffect(() => {
    if (!win || !c) return;
    keep.current?.focus();
    if (!c.fx.reducedMotion) {
      card.current?.animate(
        [
          { opacity: 0, transform: "translateY(18px) scale(0.95)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 360, easing: "cubic-bezier(.2,.9,.3,1.2)" },
      );
      coin.current?.animate(
        [
          { transform: "rotateY(900deg) scale(0.3)" },
          { transform: "rotateY(0deg) scale(1.15)", offset: 0.75 },
          { transform: "none" },
        ],
        { duration: 950, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
    const t = setTimeout(() => {
      if (!coin.current) return;
      const [x, y] = centerOf(coin.current);
      c.fx.ring(x, y, "var(--jade)", 130, 0.8, 3);
      c.fx.burst(x, y, ["var(--terracotta)", "var(--clay)", "var(--jade)", "var(--text)", "var(--clay-lit)"], 80, {
        speed: 560,
        g: 700,
        size: 4,
        life: 1.7,
      });
    }, 720);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") c.closeWin();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win]);
  if (!c || !win) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[color-mix(in_srgb,var(--anthracite)_32%,transparent)] p-4 backdrop-blur-[2px]">
      <div
        ref={card}
        role="dialog"
        aria-modal
        aria-labelledby="win-title"
        className="bg-card box-border flex w-[420px] max-w-full flex-col items-center gap-3.5 rounded-xl px-8 pt-10 pb-8 text-center shadow-[0_40px_80px_-24px_color-mix(in_srgb,var(--anthracite)_50%,transparent)]"
      >
        <span
          ref={coin}
          className="bg-jade mb-2 inline-flex p-0.5 [clip-path:polygon(26px_0,calc(100%-26px)_0,100%_26px,100%_calc(100%-26px),calc(100%-26px)_100%,26px_100%,0_calc(100%-26px),0_26px)]"
        >
          <span className="bg-jade-chip inline-flex size-[88px] items-center justify-center [clip-path:polygon(25px_0,calc(100%-25px)_0,100%_25px,100%_calc(100%-25px),calc(100%-25px)_100%,25px_100%,0_calc(100%-25px),0_25px)]">
            <svg width="36" height="36" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 6.2 5 8.2 9 3.8" stroke="var(--jade)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
        <span className="oct bg-jade inline-flex p-px">
          <span className="oct bg-jade-chip text-jade-chip-text inline-flex px-[9px] py-[3px] font-mono text-[10px] tracking-[0.1em]">
            EPIC MERGED · {win.epic.key}
          </span>
        </span>
        <h2 id="win-title" className="text-ink m-0 font-serif text-[30px] leading-[1.1] font-semibold tracking-[-0.01em]">
          {win.epic.title}
        </h2>
        <p className="text-muted m-0 max-w-[320px] text-[13px] leading-[1.55]">
          {win.tickets} ticket{win.tickets === 1 ? "" : "s"} merged by the colony. The PM Agent is drafting a
          showcase for your review.
        </p>
        <span className="text-terracotta-cta font-mono text-[22px] font-medium">+{win.bonus} epic bonus</span>
        <div className="mt-2 flex w-full gap-2">
          {onShowcase && (
            <button
              type="button"
              onClick={() => {
                c.closeWin();
                onShowcase(win.epic);
              }}
              className="bg-terracotta-cta inline-flex h-10 flex-1 items-center justify-center rounded-lg text-[13px] font-semibold text-white"
            >
              View showcase
            </button>
          )}
          <button
            ref={keep}
            type="button"
            onClick={c.closeWin}
            className="border-line bg-cream text-ink h-10 flex-1 rounded-lg border text-[13px] font-semibold"
          >
            Keep building
          </button>
        </div>
      </div>
    </div>
  );
}
