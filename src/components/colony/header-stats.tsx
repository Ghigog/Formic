"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui/cn";
import { HEAT_MAX, HEAT_WINDOW_MS, XP_PER_LEVEL, pointsOf } from "@/lib/colony/game";
import { useColony, type ColonyApi } from "./colony";

/** Counts toward the value it is given rather than jumping to it. */
function PointsCounter({ value, className }: { value: number; className?: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    const from = shown.current;
    const to = value;
    if (from === to) {
      el.textContent = to.toLocaleString("en-US");
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      shown.current = from + (to - from) * e;
      el.textContent = Math.round(shown.current).toLocaleString("en-US");
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <span
      ref={spanRef}
      data-colony="score"
      aria-live="polite"
      className={cn(
        "text-ink inline-block font-mono leading-none font-medium tabular-nums",
        className ?? "min-w-[72px] origin-right text-right text-[18px]",
      )}
    >
      {value.toLocaleString("en-US")}
    </span>
  );
}

const HEAT_LOOK = (n: number) =>
  n === 0
    ? { edge: "var(--border)", bg: "var(--cream)", ink: "var(--text-muted)" }
    : n <= 2
      ? { edge: "var(--terracotta)", bg: "var(--epic-chip)", ink: "var(--terracotta-deep)" }
      : n <= 4
        ? { edge: "var(--clay)", bg: "var(--clay-chip)", ink: "var(--clay-chip-text)" }
        : { edge: "var(--crimson)", bg: "var(--crimson-chip)", ink: "var(--crimson-chip-text)" };

function Heat({ c }: { c: ColonyApi }) {
  const look = HEAT_LOOK(c.stacks.length);
  const now = c.now;
  return (
    <span
      data-colony="heat"
      title={`Heat: each merge adds a +0.5× stack that lasts ${HEAT_WINDOW_MS / 60_000}m (max ${HEAT_MAX}). Stacks expire one at a time.`}
      className="oct inline-flex p-px transition-colors"
      style={{ background: look.edge }}
    >
      <span
        className="oct inline-flex min-w-11 flex-col items-center gap-1 px-2 pt-1.5 pb-[5px] transition-colors"
        style={{ background: look.bg }}
      >
        <span className="font-mono text-[13px] leading-none font-medium" style={{ color: look.ink }}>
          ×{c.multiplier.toFixed(1)}
        </span>
        <span aria-hidden className="flex gap-0.5">
          {Array.from({ length: HEAT_MAX }, (_, i) => {
            const exp = c.stacks[i];
            const k = exp ? Math.max(0, (exp - now) / HEAT_WINDOW_MS) : 0;
            return (
              <span key={i} className="block h-[3px] w-1 overflow-hidden bg-[color-mix(in_srgb,var(--anthracite)_12%,transparent)]">
                <span
                  className="bg-terracotta block h-[3px] transition-[width] duration-1000 ease-linear"
                  style={{ width: `${(k * 100).toFixed(1)}%` }}
                />
              </span>
            );
          })}
        </span>
      </span>
    </span>
  );
}

function SoundButton({ c }: { c: ColonyApi }) {
  return (
    <button
      type="button"
      aria-label={c.sound ? "Mute sounds" : "Unmute sounds"}
      aria-pressed={c.sound}
      onClick={() => c.setSound(!c.sound)}
      className="border-line bg-cream inline-flex size-9 shrink-0 items-center justify-center rounded-lg border max-lg:hidden"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z"
          stroke={c.sound ? "var(--text)" : "var(--text-muted)"}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        {c.sound ? (
          <path
            d="M11 5.8c.9.9.9 3.5 0 4.4M12.8 4.2c1.9 1.9 1.9 5.7 0 7.6"
            stroke="var(--text)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        ) : (
          <path d="M11 6l3.5 4M14.5 6 11 10" stroke="var(--text-muted)" strokeWidth="1.4" strokeLinecap="round" />
        )}
      </svg>
    </button>
  );
}

/** Each epic as a pip: how much of it has merged. */
function epicPips(c: ColonyApi) {
  return c.cards
    .filter((e) => e.kind === "epic")
    .map((e) => {
      const tickets = c.cards.filter((t) => t.epicId === e.id);
      const total = tickets.reduce((n, t) => n + pointsOf(t), 0);
      const done = tickets.filter((t) => t.status === "merged").reduce((n, t) => n + pointsOf(t), 0);
      return { id: e.id, title: e.title, pct: total ? done / total : 0, merged: e.status === "merged", has: total > 0 };
    })
    .filter((p) => p.has)
    .slice(0, 6);
}

function TimelineButton({ c }: { c: ColonyApi }) {
  const open = c.timelineOpen;
  return (
    <button
      data-colony="timeline"
      type="button"
      onClick={() => c.setTimelineOpen(!open)}
      aria-label={open ? "Back to board" : "Open timeline"}
      aria-expanded={open}
      className="border-line bg-card text-ink hover:border-terracotta inline-flex h-9 shrink-0 items-center gap-2.5 rounded-lg border pr-3 pl-2.5 text-[13px] font-semibold transition-[border-color,box-shadow] hover:shadow-[0_6px_14px_-10px_color-mix(in_srgb,var(--anthracite)_40%,transparent)] active:scale-[0.97]"
    >
      {open ? (
        <>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1" y="1.5" width="3.4" height="11" rx="1.2" fill="var(--text)" />
            <rect x="5.3" y="1.5" width="3.4" height="7.5" rx="1.2" fill="var(--clay)" />
            <rect x="9.6" y="1.5" width="3.4" height="4.5" rx="1.2" fill="var(--terracotta)" />
            <circle cx="11.3" cy="10.6" r="1.4" fill="var(--text-muted)" />
          </svg>
          Board
          <span className="border-line text-muted rounded border px-[5px] py-0.5 font-mono text-[9px] font-medium">
            ESC
          </span>
        </>
      ) : (
        <>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1" y="2" width="7" height="2.4" rx="1.2" fill="var(--text)" />
            <rect x="4" y="5.8" width="8" height="2.4" rx="1.2" fill="var(--clay)" />
            <rect
              x="6.5"
              y="9.6"
              width="6"
              height="2.4"
              rx="1.2"
              fill="none"
              stroke="var(--dot-idle)"
              strokeWidth="1"
              strokeDasharray="1.6 1.2"
            />
          </svg>
          Timeline
          <span aria-hidden className="flex gap-[3px] max-xl:hidden">
            {epicPips(c).map((p) => (
              <span key={p.id} title={p.title} className="bg-line block h-1 w-3.5 overflow-hidden rounded-sm">
                <span
                  className={cn("block h-1 transition-[width] duration-600", p.merged ? "bg-jade" : "bg-clay")}
                  style={{ width: `${p.pct * 100}%` }}
                />
              </span>
            ))}
          </span>
        </>
      )}
    </button>
  );
}

/**
 * The colony's corner of the header: level and rank, points and heat, the
 * sound switch and the way into the timeline.
 */
export function ColonyHeaderStats() {
  const c = useColony();
  if (!c) return null;
  const s = c.score;
  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          data-colony="level"
          className="oct-lg bg-anthracite text-cream inline-flex size-9 flex-col items-center justify-center gap-px"
          title={`Level ${s.level}`}
        >
          <span className="text-drawer-muted font-mono text-[8px] tracking-[0.1em]">LV</span>
          <span className="font-serif text-[16px] leading-none font-semibold">{s.level}</span>
        </span>
        <div className="flex flex-col gap-1.5 max-xl:hidden">
          <div className="flex items-baseline gap-2">
            <span className="text-ink text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap uppercase">
              Colony · {s.rank}
            </span>
            <span className="text-muted font-mono text-[10px] tabular-nums">
              {s.intoLevel}/{XP_PER_LEVEL}
            </span>
          </div>
          <span
            role="progressbar"
            aria-label="Experience to next level"
            aria-valuemin={0}
            aria-valuemax={XP_PER_LEVEL}
            aria-valuenow={s.intoLevel}
            className="bg-line block h-1 w-[148px] overflow-hidden rounded-sm"
          >
            <span
              className="bg-clay block h-1 transition-[width] duration-700 ease-[cubic-bezier(.2,.8,.2,1)]"
              style={{ width: `${(s.intoLevel / XP_PER_LEVEL) * 100}%` }}
            />
          </span>
        </div>
      </div>

      <span aria-hidden className="bg-line h-6 w-px shrink-0 max-xl:hidden" />

      <div className="flex shrink-0 items-center gap-2.5">
        <div className="flex flex-col items-end gap-[3px]">
          <span className="text-muted font-mono text-[9px] tracking-[0.12em]">POINTS</span>
          <PointsCounter value={c.shownPoints} />
        </div>
        <Heat c={c} />
      </div>

      <SoundButton c={c} />
      <TimelineButton c={c} />
    </>
  );
}

/**
 * The colony in the app bar below 768px: level, points and heat in one
 * 44px button that opens the timeline.
 */
export function ColonyMobileStats() {
  const c = useColony();
  if (!c) return null;
  const s = c.score;
  return (
    <button
      type="button"
      onClick={() => c.setTimelineOpen(!c.timelineOpen)}
      aria-expanded={c.timelineOpen}
      aria-label={`Level ${s.level} ${s.rank}, ${c.shownPoints} points. ${c.timelineOpen ? "Back to board" : "Open timeline"}`}
      className="flex h-11 shrink-0 items-center gap-2 rounded-[10px] px-1"
    >
      <span
        data-colony="level"
        className="oct-lg bg-anthracite text-cream inline-flex size-8 flex-col items-center justify-center"
      >
        <span className="text-drawer-muted font-mono text-[7px] tracking-[0.1em]">LV</span>
        <span className="font-serif text-[14px] leading-none font-semibold">{s.level}</span>
      </span>
      <span className="flex flex-col items-start gap-0.5 max-[359px]:hidden">
        <PointsCounter value={c.shownPoints} className="origin-left text-[14px]" />
        <span className="text-muted font-mono text-[9px]">×{c.multiplier.toFixed(1)}</span>
      </span>
    </button>
  );
}
