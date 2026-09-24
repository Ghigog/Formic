"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { XP_PER_LEVEL } from "@/lib/colony/game";
import { MarkdownLite } from "@/components/ui/markdown-lite";
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

/** The PM Agent's showcase for an epic, looked for again until it is written. */
function useShowcase(epicId: string | undefined): string | null {
  const [found, setFound] = useState<{ id: string; text: string } | null>(null);
  const text = found && found.id === epicId ? found.text : null;
  useEffect(() => {
    if (!epicId || text) return;
    let live = true;
    const look = () =>
      fetch(`/api/epics/${epicId}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<{ showcase?: string | null }>) : null))
        .then((body) => {
          if (live && body?.showcase) setFound({ id: epicId, text: body.showcase });
        })
        .catch(() => undefined);
    void look();
    const timer = setInterval(() => void look(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [epicId, text]);
  return text;
}

/** A number that counts up to its value once, from zero. */
function useCountUp(value: number, run: boolean, reduced: boolean): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!run || reduced) return;
    let frame = 0;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 1100);
      setShown(Math.round(value * (1 - Math.pow(1 - k, 3))));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, run, reduced]);
  return reduced ? value : shown;
}

/** An epic landed in Done: what it scored, where the colony stands, and what shipped. */
export function EpicWinDialog({ onShowcase }: { onShowcase?: (epic: BoardCard) => void }) {
  const c = useColony();
  const backdrop = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const coin = useRef<HTMLSpanElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const win = c?.win;
  const showcase = useShowcase(win?.epic.id);
  const total = useCountUp(win?.tally.total ?? 0, !!win, !!c?.fx.reducedMotion);

  useEffect(() => {
    if (!win || !c) return;
    keep.current?.focus();
    if (!c.fx.reducedMotion) {
      backdrop.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
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

  const { tally } = win;
  const s = c.score;

  return (
    <div
      ref={backdrop}
      onClick={c.closeWin}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[color-mix(in_srgb,var(--anthracite)_38%,transparent)] p-4 backdrop-blur-md"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal
        aria-labelledby="win-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-card box-border flex max-h-[calc(100dvh-32px)] w-[480px] max-w-full flex-col items-center gap-3.5 overflow-y-auto rounded-xl px-6 pt-9 pb-6 text-center shadow-[0_40px_80px_-24px_color-mix(in_srgb,var(--anthracite)_50%,transparent)] sm:px-8"
      >
        <span
          ref={coin}
          className="bg-jade mb-1 inline-flex shrink-0 p-0.5 [clip-path:polygon(26px_0,calc(100%-26px)_0,100%_26px,100%_calc(100%-26px),calc(100%-26px)_100%,26px_100%,0_calc(100%-26px),0_26px)]"
        >
          <span className="bg-jade-chip inline-flex size-[80px] items-center justify-center [clip-path:polygon(25px_0,calc(100%-25px)_0,100%_25px,100%_calc(100%-25px),calc(100%-25px)_100%,25px_100%,0_calc(100%-25px),0_25px)]">
            <svg width="34" height="34" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 6.2 5 8.2 9 3.8" stroke="var(--jade)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
        <span className="oct bg-jade inline-flex p-px">
          <span className="oct bg-jade-chip text-jade-chip-text inline-flex px-[9px] py-[3px] font-mono text-[10px] tracking-[0.1em]">
            EPIC COMPLETE · {win.epic.key}
          </span>
        </span>
        <h2 id="win-title" className="text-ink m-0 font-serif text-[28px] leading-[1.1] font-semibold tracking-[-0.01em]">
          {win.epic.title}
        </h2>

        <div className="border-line flex w-full flex-col gap-2 rounded-lg border p-4 text-left">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted font-mono text-[10px] tracking-[0.12em]">EPIC SCORE</span>
            <span className="text-terracotta-cta font-mono text-[26px] leading-none font-medium tabular-nums">
              +{total}
            </span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {tally.tickets.map((t) => (
              <li key={t.id} className="flex items-baseline gap-2 text-[12px]">
                <span className="text-muted shrink-0 font-mono text-[10px]">{t.key}</span>
                <span className="text-ink min-w-0 flex-1 truncate">{t.title}</span>
                {t.mult > 1 && (
                  <span className="text-muted shrink-0 font-mono text-[10px]">×{t.mult.toFixed(1)}</span>
                )}
                <span className="text-ink shrink-0 font-mono tabular-nums">+{t.pts}</span>
              </li>
            ))}
            <li className="border-line mt-1 flex items-baseline gap-2 border-t pt-2 text-[12px]">
              <span className="text-ink flex-1 font-semibold">Epic bonus</span>
              <span className="text-terracotta-cta shrink-0 font-mono tabular-nums">+{tally.bonus}</span>
            </li>
          </ul>
        </div>

        <div className="flex w-full items-center gap-3 text-left">
          <span className="oct-lg bg-anthracite text-cream inline-flex size-10 shrink-0 flex-col items-center justify-center gap-px">
            <span className="text-drawer-muted font-mono text-[8px] tracking-[0.1em]">LV</span>
            <span className="font-serif text-[17px] leading-none font-semibold">{s.level}</span>
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ink text-[11px] font-semibold tracking-[0.06em] uppercase">Colony · {s.rank}</span>
              <span className="text-muted font-mono text-[10px] tabular-nums">
                {XP_PER_LEVEL - s.intoLevel} XP to Lv {s.level + 1}
              </span>
            </div>
            <span
              role="progressbar"
              aria-label="Experience to next level"
              aria-valuemin={0}
              aria-valuemax={XP_PER_LEVEL}
              aria-valuenow={s.intoLevel}
              className="bg-line block h-1.5 w-full overflow-hidden rounded-sm"
            >
              <span className="bg-clay block h-full" style={{ width: `${(s.intoLevel / XP_PER_LEVEL) * 100}%` }} />
            </span>
          </div>
        </div>

        <div className="bg-sunken w-full rounded-lg p-4 text-left">
          <span className="text-muted font-mono text-[10px] tracking-[0.12em]">SUMMARY</span>
          {showcase ? (
            <MarkdownLite text={showcase} className="text-ink mt-2 max-h-[220px] overflow-y-auto text-[13px] leading-[1.55]" />
          ) : (
            <p className="text-muted m-0 mt-2 animate-pulse text-[13px] leading-[1.55]">
              The PM Agent is writing the summary…
            </p>
          )}
        </div>

        <div className="mt-1 flex w-full gap-2">
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
