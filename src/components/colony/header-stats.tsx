"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import {
  HEAT_MAX,
  HEAT_WINDOW_MS,
  XP_PER_LEVEL,
  isMaxLevel,
  pointsOf,
} from "@/lib/colony/game";
import { SENTINELS } from "@/lib/sentinels/roster";
import { useSentinels } from "@/components/sentinels/store";
import { useColony, type ColonyApi } from "./colony";
import { FeatureReveal } from "./feature-reveal";
import type { SoundEngine } from "./sound";

/** Counts toward the value it is given rather than jumping to it. */
function PointsCounter({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
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
        "inline-block font-mono leading-none font-medium tabular-nums",
        className ?? "text-[18px]",
      )}
    >
      {value.toLocaleString("en-US")}
    </span>
  );
}

/** The panel's tint and text climb from terracotta to clay to crimson with the stacks. */
const HEAT_TIER = (n: number) =>
  n <= 0
    ? null
    : n <= 2
      ? { bg: "var(--epic-chip)", ink: "var(--terracotta-deep)" }
      : n <= 4
        ? { bg: "var(--clay-chip)", ink: "var(--clay-chip-text)" }
        : { bg: "var(--crimson-chip)", ink: "var(--crimson-chip-text)" };

/**
 * The stacks as HEAT_MAX pips, filled for each active one, and the multiplier
 * from ×1.5 up. The element stays as the merge effect's target; its tooltip
 * has the time left on each stack.
 */
function Heat({ c }: { c: ColonyApi }) {
  const n = c.stacks.length;
  const now = c.now;
  const tip = `Heat ×${c.multiplier.toFixed(1)}: each merge adds a +0.5× stack that lasts ${HEAT_WINDOW_MS / 60_000}m (max ${HEAT_MAX}). Stacks expire one at a time.\n${Array.from(
    { length: HEAT_MAX },
    (_, i) => {
      const exp = c.stacks[i];
      if (!exp) return `Stack ${i + 1}: empty`;
      const left = Math.max(0, Math.ceil((exp - now) / 1000));
      return `Stack ${i + 1}: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
    },
  ).join("\n")}`;
  return (
    <span
      data-colony="heat"
      title={n > 0 ? tip : undefined}
      className="inline-flex items-center gap-1.5"
    >
      {n > 0 && (
        <span className="font-mono text-[10px] leading-none font-medium">
          ×{c.multiplier.toFixed(1)}
        </span>
      )}
      <span aria-hidden className="flex gap-0.5">
        {Array.from({ length: HEAT_MAX }, (_, i) => (
          <span
            key={i}
            data-pip={i < n ? "on" : "off"}
            className="block h-2.5 w-[3px] rounded-sm bg-current transition-opacity"
            style={{ opacity: i < n ? 1 : 0.2 }}
          />
        ))}
      </span>
    </span>
  );
}

/** The points in a panel whose colour follows the heat, neutral with none. */
function PointsPanel({
  c,
  className,
  children,
}: {
  c: ColonyApi;
  className?: string;
  children: ReactNode;
}) {
  const tier = HEAT_TIER(c.stacks.length);
  return (
    <div
      data-colony="points-panel"
      className={cn(
        "border-line bg-card text-ink inline-flex shrink-0 items-center rounded-lg border transition-colors",
        className,
      )}
      style={
        tier
          ? { backgroundColor: tier.bg, color: tier.ink, borderColor: tier.ink }
          : undefined
      }
    >
      {children}
      <Heat c={c} />
    </div>
  );
}

/** Each epic as a pip: how much of it has merged. */
function epicPips(c: ColonyApi) {
  return c.cards
    .filter((e) => e.kind === "epic")
    .map((e) => {
      const tickets = c.cards.filter((t) => t.epicId === e.id);
      const total = tickets.reduce((n, t) => n + pointsOf(t), 0);
      const done = tickets
        .filter((t) => t.status === "merged")
        .reduce((n, t) => n + pointsOf(t), 0);
      return {
        id: e.id,
        title: e.title,
        pct: total ? done / total : 0,
        merged: e.status === "merged",
        has: total > 0,
      };
    })
    .filter((p) => p.has)
    .slice(0, 6);
}

/**
 * The header holds a full and an icon-only Timeline button, one hidden by the
 * breakpoint. Both rise on a reveal, but only the one in view gets the cue.
 */
function cueOnlyWhen(sound: SoundEngine, iconOnly: boolean): SoundEngine {
  const mine = () =>
    typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 768px)").matches !== iconOnly;
  return {
    whenAudible: (cb: () => void) => (mine() ? sound.whenAudible(cb) : undefined),
    play: (...a: Parameters<SoundEngine["play"]>) => (mine() ? sound.play(...a) : undefined),
  } as unknown as SoundEngine;
}

function TimelineButton({
  c,
  iconOnly = false,
}: {
  c: ColonyApi;
  iconOnly?: boolean;
}) {
  const open = c.timelineOpen;
  if (!c.featureUnlocked("timeline")) return null;
  return (
    <FeatureReveal reveal={c.revealing === "timeline"} sound={cueOnlyWhen(c.sound, iconOnly)} onSettled={c.settleReveal}>
    <button
      data-colony="timeline"
      data-tour="timeline"
      type="button"
      onClick={() => c.setTimelineOpen(!open)}
      aria-label={open ? "Back to board" : "Open timeline"}
      aria-expanded={open}
      className={cn(
        "border-line bg-card text-ink hover:border-terracotta inline-flex shrink-0 items-center rounded-lg border text-[13px] font-semibold transition-[border-color,box-shadow] hover:shadow-[0_6px_14px_-10px_color-mix(in_srgb,var(--anthracite)_40%,transparent)] active:scale-[0.97]",
        iconOnly ? "size-11 justify-center" : "h-9 gap-2.5 pr-3 pl-2.5",
      )}
    >
      {open ? (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="1"
              y="1.5"
              width="3.4"
              height="11"
              rx="1.2"
              fill="var(--text)"
            />
            <rect
              x="5.3"
              y="1.5"
              width="3.4"
              height="7.5"
              rx="1.2"
              fill="var(--clay)"
            />
            <rect
              x="9.6"
              y="1.5"
              width="3.4"
              height="4.5"
              rx="1.2"
              fill="var(--terracotta)"
            />
            <circle cx="11.3" cy="10.6" r="1.4" fill="var(--text-muted)" />
          </svg>
          {!iconOnly && (
            <>
              Board
              <span className="border-line text-muted rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium">
                ESC
              </span>
            </>
          )}
        </>
      ) : (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="1"
              y="2"
              width="7"
              height="2.4"
              rx="1.2"
              fill="var(--text)"
            />
            <rect
              x="4"
              y="5.8"
              width="8"
              height="2.4"
              rx="1.2"
              fill="var(--clay)"
            />
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
          {!iconOnly && (
            <>
              Timeline
              <span aria-hidden className="flex gap-1 max-xl:hidden">
                {epicPips(c).map((p) => (
                  <span
                    key={p.id}
                    title={p.title}
                    className="bg-line block h-1 w-3.5 overflow-hidden rounded-sm"
                  >
                    <span
                      className={cn(
                        "block h-1 transition-[width] duration-600",
                        p.merged ? "bg-jade" : "bg-clay",
                      )}
                      style={{ width: `${p.pct * 100}%` }}
                    />
                  </span>
                ))}
              </span>
            </>
          )}
        </>
      )}
    </button>
    </FeatureReveal>
  );
}

const LEVEL_UP_DELAY_MS = 1500;
const FLASH_MS = 500;

/**
 * The black LV octagon. With Sentinels around it is also the Audit button:
 * hover or focus swaps LV for the grade, and after each level-up the grade
 * flashes once as a diagonal slice.
 */
export function LevelBadge({
  level,
  size,
}: {
  level: number;
  size: 36 | 32;
}) {
  const c = useColony();
  const s = useSentinels();
  const [flashing, setFlashing] = useState(false);
  const prev = useRef(level);
  const reduced = c?.fx.reducedMotion ?? false;
  useEffect(() => {
    const was = prev.current;
    prev.current = level;
    if (level <= was) return;
    let off: ReturnType<typeof setTimeout>;
    const on = setTimeout(() => {
      setFlashing(true);
      off = setTimeout(() => setFlashing(false), FLASH_MS);
    }, LEVEL_UP_DELAY_MS);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
      setFlashing(false);
    };
  }, [level]);

  const big = size === 36;
  const face = "absolute inset-0 flex flex-col items-center justify-center gap-px";
  const label = "font-mono text-[10px] leading-none tracking-[0.1em]";
  const num = cn(
    "font-serif leading-none font-semibold",
    big ? "text-[15px]" : "text-[13px]",
  );
  const box = cn(
    "oct-lg bg-anthracite text-on-anthracite relative inline-flex shrink-0",
    big ? "size-9" : "size-8",
  );
  const lv = (
    <span
      className={cn(
        face,
        "transition-opacity duration-150",
        s && "group-hover:opacity-0 group-focus-visible:opacity-0",
        flashing && reduced && "opacity-0",
      )}
    >
      <span className={cn(label, "text-drawer-muted")}>LV</span>
      <span className={num}>{level}</span>
    </span>
  );
  if (!c || !s || !c.featureUnlocked("sentinels")) {
    return (
      <span data-colony="level" className={box} title={`Level ${level}`}>
        {lv}
      </span>
    );
  }
  const g = s.grade;
  const busy = SENTINELS.some((x) => s.states[x.id]?.running);
  const audit = (extra: string, sweep?: boolean) => (
    <span
      data-audit-face={sweep ? "flash" : "hover"}
      aria-hidden
      className={cn(face, "bg-anthracite text-on-anthracite", extra)}
    >
      <span className={label}>AUDIT</span>
      <span className={num}>{g.grade}</span>
    </span>
  );
  return (
    <button
      type="button"
      data-colony="level"
      onClick={() => c.setSentinelsOpen(!c.sentinelsOpen)}
      aria-expanded={c.sentinelsOpen}
      aria-label={`Audit grade ${g.grade}, Level ${level}, ${g.avg.toFixed(1)} of 5 from ${g.done} of ${g.total} sentinels. ${c.sentinelsOpen ? "Back to board" : "Open sentinels"}`}
      title={`Sentinels · grade ${g.grade} · ${g.avg.toFixed(2)} avg · Level ${level}`}
      className={cn(
        box,
        "group transition-transform active:scale-[0.94] focus-visible:outline-2",
      )}
    >
      {lv}
      {audit(
        "invisible opacity-0 transition-[opacity,visibility] duration-150 group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100",
      )}
      {flashing &&
        (reduced
          ? audit("", true)
          : audit("motion-safe:animate-[auditSweep_500ms_ease-in-out_both]", true))}
      {busy && (
        <span className="bg-clay-lit absolute top-0.5 right-0.5 size-1.5 motion-safe:animate-[dotPulse_1s_ease-in-out_infinite] rounded-full" />
      )}
    </button>
  );
}

/** The level badge and the LV badge and the rank and XP bar. */
export function ColonyLevelStats() {
  const c = useColony();
  if (!c) return null;
  const s = c.score;
  return (
    <div data-tour={c.featureUnlocked("sentinels") ? "sentinels" : undefined} className="flex shrink-0 items-center gap-2.5">
      <FeatureReveal reveal={c.revealing === "sentinels"} sound={c.sound} onSettled={c.settleReveal}>
        <LevelBadge level={s.level} size={36} />
      </FeatureReveal>
      <div className="flex flex-col gap-1.5 max-xl:hidden">
        <div className="flex items-baseline gap-2">
          <span className="text-ink text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap uppercase">
            Colony · {s.rank}
          </span>
          <span className="text-muted font-mono text-[10px] tabular-nums">
            {isMaxLevel(s.level) ? "Max level" : `${s.intoLevel}/${XP_PER_LEVEL}`}
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
  );
}

/**
 * The colony's corner of the header: the level,
 * rank, points and heat, and the way into the timeline.
 */
export function ColonyHeaderStats({
  showLevel = true,
}: {
  showLevel?: boolean;
}) {
  const c = useColony();
  if (!c) return null;
  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5">
        {showLevel && <ColonyLevelStats />}
      </div>

      <span aria-hidden className="bg-line h-6 w-px shrink-0 max-xl:hidden" />

      <div data-tour="points" className="flex shrink-0 items-center gap-2.5">
        <PointsPanel c={c} className="h-9 gap-2.5 px-3">
          <PointsCounter value={c.shownPoints} />
        </PointsPanel>
      </div>

      <TimelineButton c={c} />
    </>
  );
}

/**
 * The colony in the app bar below 768px: a level and points
 * button, heat, and an icon-only timeline button.
 */
export function ColonyMobileStats() {
  const c = useColony();
  if (!c) return null;
  const s = c.score;
  return (
    <>
      <div
        role="group"
        aria-label={`Level ${s.level} ${s.rank}, ${c.shownPoints} points`}
        data-tour={c.featureUnlocked("sentinels") ? "points sentinels" : "points"}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-1"
      >
        <LevelBadge level={s.level} size={32} />
        <PointsPanel c={c} className="h-8 gap-1.5 px-2">
          <PointsCounter
            value={c.shownPoints}
            className="origin-left text-[13px] max-[359px]:hidden"
          />
        </PointsPanel>
      </div>
      <TimelineButton c={c} iconOnly />
    </>
  );
}
