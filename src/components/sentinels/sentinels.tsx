"use client";

import { AutoTour } from "@/components/onboarding/tour";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { useColony, type ColonyApi } from "@/components/colony/colony";
import { centerOf } from "@/components/colony/fx";
import { cappedByFindings } from "@/lib/sentinels/rubric";
import { GRADE_RULE, gradeRose } from "@/lib/sentinels/grade";
import {
  GROUP_INK,
  SENTINELS,
  isUnlocked,
  promptFor,
  stepsFor,
  type Sentinel,
} from "@/lib/sentinels/roster";
import type { SentinelState } from "@/lib/sentinels/view";
import type { AuditKind, AuditPoint } from "@/lib/db/repository";
import { KpiSection } from "./kpi";
import { portraitSvg, portraitGround } from "./portraits";
import { useSentinels, type SentinelsApi } from "./store";

/** The level badge's octagon, chamfered for an 84px grade. */
const BIG_OCT =
  "polygon(22px 0,calc(100% - 22px) 0,100% 22px,100% calc(100% - 22px),calc(100% - 22px) 100%,22px 100%,0 calc(100% - 22px),0 22px)";

const STAR =
  "M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 11.9l-4.2 2.3.8-4.7L1.2 6.2l4.7-.7z";

function Stars({ n, size, id, dull }: { n: number; size: number; id?: string; dull?: boolean }) {
  return (
    <span className={cn("flex items-center gap-0.5", dull && "opacity-50")} aria-hidden data-dull={dull || undefined}>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg
          key={i}
          data-star={id}
          width={size}
          height={size}
          viewBox="0 0 16 16"
        >
          <path d={STAR} fill={i < n ? "var(--clay)" : "var(--border)"} />
        </svg>
      ))}
      {dull && (
        <span className="text-muted ml-1 font-mono text-[12px] leading-none">?</span>
      )}
    </span>
  );
}

/**
 * A portrait in the frame the page gives it — the frame itself lives in
 * `portraits.ts` with the art, so the card, the report avatar and the tests
 * all inline the same markup.
 */
function Portrait({ id, className }: { id: string; className?: string }) {
  return (
    <span
      aria-hidden
      data-avatar={id}
      className={cn("absolute inset-0 block", className)}
      dangerouslySetInnerHTML={{ __html: portraitSvg(id) }}
    />
  );
}

function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3.5 2.2v9.6L11.5 7z" fill="var(--clay-lit)" />
    </svg>
  );
}

/** Whether a sentinel has reported: the ones worth celebrating. */
const reported = (st: SentinelState | undefined) => st?.stars != null;

const SLIDE_MS = 520;
const SLIDE_STAGGER_MS = 110;
/** Hover scrubbing across the rail makes one voice per this long. */
const VOICE_GAP_MS = 120;
/** A wheel gesture ends once the wheel has been quiet this long. */
const WHEEL_QUIET_MS = 160;
/** Tailwind's md breakpoint: from here up the rail scrolls freely. */
const DESKTOP = "(min-width: 768px)";

function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * The Sentinels: twelve auditors who each read the codebase against their
 * own brief, report, and rate it. Their average is the project's grade.
 * Covers the board between the header and the ambient bar, like the timeline.
 */
export function SentinelsPage(_: { repoName: string }) {
  const c = useColony();
  const s = useSentinels();
  if (!c?.sentinelsOpen || !s) return null;
  return <SentinelsView c={c} s={s} />;
}

function SentinelsView({ c, s }: { c: ColonyApi; s: SentinelsApi }) {
  const root = useRef<HTMLDivElement>(null);
  const gradeRef = useRef<HTMLSpanElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  /** The centred sentinel; the ref lets rapid steps build on each other. */
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(0);
  /** The sentinel whose report is open in the modal. */
  const [reportId, setReportId] = useState<string | null>(null);
  const reportRef = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const g = s.grade;

  const goTo = (i: number) => {
    const el = rail.current;
    const item = el?.children[i] as HTMLElement | undefined;
    idxRef.current = i;
    setIdx(i);
    el?.scrollTo({
      left: item
        ? item.offsetLeft + item.offsetWidth / 2 - el.clientWidth / 2
        : 0,
      behavior: c.fx.reducedMotion ? "auto" : "smooth",
    });
  };
  /** One sentinel left or right, stopping at the first and last. */
  const step = (dir: -1 | 1) => {
    const i = Math.min(SENTINELS.length - 1, Math.max(0, idxRef.current + dir));
    if (i !== idxRef.current) goTo(i);
  };
  const closeReport = () => {
    const id = reportRef.current;
    reportRef.current = null;
    setReportId(null);
    root.current?.querySelector<HTMLElement>(`[data-card="${id}"]`)?.focus();
  };
  /** The card nearest the rail's middle, measured from the layout as it is now. */
  const centredNow = () => {
    const el = rail.current;
    if (!el) return idxRef.current;
    const mid = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let gap = Infinity;
    Array.from(el.children).forEach((child, i) => {
      const it = child as HTMLElement;
      const d = Math.abs(it.offsetLeft + it.offsetWidth / 2 - mid);
      if (d < gap) {
        gap = d;
        best = i;
      }
    });
    return best;
  };
  // The centred index follows the scroll position, so swipes keep it right.
  const onScroll = () => {
    const best = centredNow();
    idxRef.current = best;
    setIdx(best);
  };

  // On mobile a mouse wheel gesture is one step: further wheel events are swallowed
  // until the wheel has been quiet, which also absorbs trackpad inertia.
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      if (window.matchMedia(DESKTOP).matches) return;
      e.preventDefault();
      if (quiet === undefined)
        step(
          (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) < 0
            ? -1
            : 1,
        );
      clearTimeout(quiet);
      quiet = setTimeout(() => (quiet = undefined), WHEEL_QUIET_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      clearTimeout(quiet);
      el.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The board behind must not scroll while the screen is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus moves into the report modal when it opens.
  useEffect(() => {
    if (reportId)
      root.current?.querySelector<HTMLElement>("[role=dialog] button")?.focus();
  }, [reportId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (reportRef.current) closeReport();
        else c.setSentinelsOpen(false);
      } else if (
        !reportRef.current &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        step(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    // Reported cards slide up one after another; the rest fade in by CSS.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const landed = SENTINELS.map((x, i) => ({ x, i })).filter(({ x }) =>
      reported(s.states[x.id]),
    );
    if (landed.length && !c.fx.reducedMotion) {
      landed.forEach(({ x }, n) => {
        const delay = n * SLIDE_STAGGER_MS;
        root.current
          ?.querySelector<HTMLElement>(`[data-card="${x.id}"]`)
          ?.animate(
            [
              {
                opacity: 0,
                transform: `translateY(60vh) rotate(${n % 2 ? 4 : -4}deg)`,
              },
              { opacity: 1, transform: "none" },
            ],
            {
              duration: SLIDE_MS,
              delay,
              easing: "cubic-bezier(.2,.8,.2,1)",
              fill: "backwards",
            },
          );
        timers.push(
          setTimeout(() => c.sfx("sentinelLand", n), delay + SLIDE_MS),
        );
      });
    }
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A report landing: its stars pop in one by one, and the grade flips if it moved.
  const prev = useRef(s.states);
  const prevGrade = useRef(g.grade);
  useEffect(() => {
    const before = prev.current;
    prev.current = s.states;
    const reduce = c.fx.reducedMotion;
    for (const x of SENTINELS) {
      const was = before[x.id];
      const is = s.states[x.id];
      if (!was?.running || is?.running) continue;
      if (is?.error && is.error !== was.error) {
        c.sfx("deny");
        continue;
      }
      if (!is?.at || is.at === was.at) continue;
      const stars = is.stars ?? 0;
      const els =
        root.current?.querySelectorAll<SVGElement>(`[data-star="${x.id}"]`) ??
        [];
      for (let i = 0; i < stars; i++) {
        setTimeout(() => {
          c.sfx("blip", i * 2 + 7);
          if (!reduce)
            els[i]?.animate(
              [
                { transform: "scale(0.2) rotate(-40deg)" },
                { transform: "scale(1.45)" },
                { transform: "scale(1)" },
              ],
              { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" },
            );
        }, i * 110);
      }
      const card = root.current?.querySelector<HTMLElement>(
        `[data-card="${x.id}"]`,
      );
      if (card && !reduce)
        card.animate(
          [
            { transform: "none" },
            { transform: "translateY(-8px)" },
            { transform: "none" },
          ],
          {
            duration: 420,
            easing: "cubic-bezier(.2,.8,.2,1)",
          },
        );
    }
    if (g.grade !== prevGrade.current) {
      const up = gradeRose(prevGrade.current, g.grade);
      prevGrade.current = g.grade;
      setTimeout(() => {
        const el = gradeRef.current;
        c.sfx(up ? "level" : "bad");
        if (!el || reduce) return;
        el.animate(
          up
            ? [
                { transform: "rotateY(0) scale(1)" },
                { transform: "rotateY(360deg) scale(1.2)" },
                { transform: "rotateY(360deg) scale(1)" },
              ]
            : [
                { transform: "none" },
                { transform: "translateX(-6px)" },
                { transform: "translateX(5px)" },
                { transform: "none" },
              ],
          { duration: up ? 700 : 360, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
        if (up) {
          const [x, y] = centerOf(el);
          c.fx.ring(x, y, g.ink, 60, 0.5, 3);
          c.fx.burst(x, y, [g.ink, "var(--clay-lit)"], 18, {
            speed: 180,
            g: 220,
            size: 2,
            life: 0.6,
            shape: "dot",
          });
        }
      }, 700);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.states]);

  // An avatar's reaction and its sentinel's voice. Hopping and tilting is
  // motion; the voice is not, and is throttled so scrubbing does not stack.
  const lastVoice = useRef(0);
  const react = (id: string) => {
    const now = performance.now();
    if (now - lastVoice.current >= VOICE_GAP_MS) {
      lastVoice.current = now;
      c.sfx(
        "sentinelVoice",
        SENTINELS.findIndex((x) => x.id === id),
      );
    }
    if (c.fx.reducedMotion) return;
    root.current
      ?.querySelector<HTMLElement>(`[data-card="${id}"] [data-avatar]`)
      ?.animate(
        [
          { transform: "none" },
          {
            transform: "translateY(-10px) rotate(-5deg) scale(1.06)",
            offset: 0.35,
          },
          {
            transform: "translateY(0) rotate(3deg) scale(1.04, 0.94)",
            offset: 0.65,
          },
          { transform: "none" },
        ],
        { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
  };

  const unlocked = SENTINELS.filter((x) => isUnlocked(x, s.level)).length;
  const nBusy = SENTINELS.filter((x) => s.states[x.id]?.running).length;
  const summon = (id: string, kind?: AuditKind) => {
    c.sfx("emerge");
    void s.summon(id, kind ?? (s.states[id]?.rubric ? "audit" : "calibrate"));
  };
  const reporting = SENTINELS.find((x) => x.id === reportId);

  return (
    <div
      ref={root}
      role="region"
      aria-label="Sentinels"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 z-[60] box-border overflow-x-hidden overflow-y-auto overscroll-none px-4 pt-5 pb-6 md:top-16 md:px-6"
    >
      <div className="mx-auto flex min-h-full max-w-[1640px] flex-col gap-4">
        <h1 className="sr-only">Sentinels</h1>
        <AutoTour id="sentinels" delay={450} />
        <section data-tour="sentinels-grade" className="border-line bg-card flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 rounded-[14px] border px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <div className="flex items-baseline gap-2.5">
                <span className="text-ink font-mono text-[12px] font-medium">
                  {g.avg.toFixed(2)} / 5 avg
                </span>
                <span className="text-muted text-[12px]">
                  {g.done} of {g.total} reported
                </span>
              </div>
              <span className="bg-line block h-1 w-full max-w-[238px] overflow-hidden rounded-sm">
                <span
                  className="bg-clay block h-1 transition-[width] duration-700 ease-[cubic-bezier(.2,.8,.2,1)]"
                  style={{ width: `${g.progress * 100}%` }}
                />
              </span>
              <span className="text-muted text-[12px]">
                {g.total === 0
                  ? `${SENTINELS[0]!.name} unlocks at Lv ${SENTINELS[0]!.unlockLevel}`
                  : g.next
                  ? `${g.next.grade} at ${g.next.min.toFixed(1)} avg · ${g.next.need} more star${g.next.need === 1 ? "" : "s"}`
                  : "Top grade reached"}
              </span>
            </div>
            <span
              ref={gradeRef}
              title={GRADE_RULE}
              className="text-cream inline-flex size-[68px] sm:size-[84px] shrink-0 flex-col items-center justify-center gap-0.5 transition-[background] duration-400"
              style={{ background: g.ink, clipPath: BIG_OCT }}
            >
              <span className="font-mono text-[9px] tracking-[0.14em] opacity-80">
                GRADE
              </span>
              <span className="font-serif text-[32px] sm:text-[42px] leading-none font-semibold">
                {g.grade}
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              c.sfx("emerge");
              s.summonAll();
            }}
            disabled={nBusy === unlocked}
            data-tour="sentinels-summon"
            className="bg-anthracite text-cream inline-flex h-11 w-full items-center justify-center gap-2.5 sm:w-auto rounded-[10px] px-[18px] text-[14px] font-semibold transition-transform active:scale-[0.97] disabled:opacity-70"
          >
            <PlayIcon />
            {nBusy ? `Auditing ${nBusy}…` : `Summon all ${unlocked}`}
          </button>
        </section>

        {s.refusal && (
          <p
            role="alert"
            className="bg-crimson-chip text-crimson-chip-text m-0 rounded-lg px-4 py-2.5 text-[13px]"
          >
            {s.refusal}
          </p>
        )}

        <div className="relative flex min-h-[460px] flex-1 flex-col">
          <div
            ref={rail}
            data-tour="sentinels-roster"
            role="list"
            aria-label="Sentinels"
            onScroll={onScroll}
            className="relative flex min-h-fit flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden overscroll-contain touch-pan-x px-[calc(50%-132px)] pb-2 md:min-h-0 md:snap-none md:px-1"
          >
            {SENTINELS.map((x, i) => (
              <Card
                key={x.id}
                x={x}
                st={s.states[x.id]!}
                on={i === idx}
                now={now}
                locked={!isUnlocked(x, s.level)}
                onActivate={() => {
                  // On a phone the rail snaps, and a side card comes to the
                  // centre before it opens. Measure the centre now: the scroll
                  // event that would update idx may not have arrived yet. From
                  // md up the rail scrolls freely and any card opens.
                  if (!window.matchMedia(DESKTOP).matches && i !== centredNow()) goTo(i);
                  else {
                    c.sfx("blip", 5);
                    reportRef.current = x.id;
                    setReportId(x.id);
                  }
                }}
                onReact={react}
                onSummon={summon}
              />
            ))}
          </div>
          <button
            type="button"
            aria-label="Previous sentinel"
            onClick={() => step(-1)}
            disabled={idx === 0}
            className="border-line bg-card text-ink absolute top-1/2 left-1 size-9 -translate-y-1/2 rounded-full border disabled:opacity-40"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next sentinel"
            onClick={() => step(1)}
            disabled={idx === SENTINELS.length - 1}
            className="border-line bg-card text-ink absolute top-1/2 right-1 size-9 -translate-y-1/2 rounded-full border disabled:opacity-40"
          >
            ›
          </button>
        </div>
        <KpiSection />
      </div>

      {reporting && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgb(28_25_23/0.45)] p-4"
          onClick={closeReport}
        >
          <div
            role="dialog"
            aria-modal
            aria-label={`${reporting.who} audit report`}
            onClick={(e) => e.stopPropagation()}
            className="relative max-h-full w-full max-w-[460px] overflow-auto rounded-[14px]"
          >
            <AutoTour id="sentinel-report" delay={450} />
            <button
              type="button"
              aria-label="Close"
              onClick={closeReport}
              className="border-line bg-cream text-ink absolute top-3 right-3 z-10 size-8 rounded-full border"
            >
              ×
            </button>
            <Report
              x={reporting}
              st={s.states[reporting.id]!}
              now={now}
              locked={!isUnlocked(reporting, s.level)}
              onSummon={(kind) => summon(reporting.id, kind)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Card({
  x,
  st,
  on,
  now,
  locked,
  onActivate,
  onReact,
  onSummon,
}: {
  x: Sentinel;
  st: SentinelState;
  on: boolean;
  now: number;
  locked: boolean;
  onActivate: () => void;
  onReact: (id: string) => void;
  onSummon: (id: string) => void;
}) {
  const running = !!st.running;
  const done = !running && st.stars !== null;
  const steps = stepsFor(x, st.running?.kind);
  const step = st.running?.log.length ? st.running.log.length - 1 : 0;
  return (
    <div
      role="listitem"
      data-card={x.id}
      tabIndex={0}
      aria-label={`${x.who}, ${x.name}. ${st.stars !== null ? `${st.stars} of 5 stars${st.auditStale ? ", out of date" : ""}` : "Not audited"}`}
      aria-current={on || undefined}
      onClick={onActivate}
      onPointerEnter={() => onReact(x.id)}
      onFocus={() => onReact(x.id)}
      onKeyDown={(e) => {
        // Keys pressed on the Summon button belong to the button, not the card.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "bg-card focus-visible:border-terracotta flex w-[264px] shrink-0 cursor-pointer snap-center snap-always flex-col md:snap-align-none md:snap-normal overflow-hidden rounded-[14px] border outline-none transition-[border-color,box-shadow] hover:shadow-[0_14px_28px_-20px_rgb(28_25_23/0.55)]",
        !reported(st) && "sentinel-motion animate-[sentinelFade_0.4s_ease-out]",
        on
          ? "border-terracotta shadow-[0_0_0_3px_rgb(217_107_39/0.14)]"
          : "border-line",
      )}
    >
      <div
        className="relative h-[180px] shrink-0 overflow-hidden md:h-auto md:min-h-[120px] md:flex-1 md:shrink"
        style={{ background: portraitGround(x.id) }}
      >
        <div
          className={cn(
            "absolute inset-0",
            locked && "opacity-40 grayscale",
            running &&
              "sentinel-motion animate-[sentinelBob_0.9s_ease-in-out_infinite]",
          )}
        >
          <Portrait id={x.id} />
        </div>
        <span className="text-anthracite absolute top-2.5 left-2.5 rounded-full bg-white/90 px-2 py-1 font-mono text-[9px] font-medium tracking-[0.12em] uppercase">
          {x.name}
        </span>
        <span
          title={x.group}
          className="absolute top-2.5 right-2.5 size-2 rounded-full shadow-[0_0_0_2px_rgb(255_255_255/0.88)]"
          style={{ background: GROUP_INK[x.group] }}
        />
        {running && (
          <>
            <div className="absolute inset-0 bg-[rgb(28_25_23/0.18)]" />
            <div className="bg-clay-lit sentinel-motion absolute right-0 left-0 h-[3px] animate-[sentinelScan_1.1s_ease-in-out_infinite_alternate] shadow-[0_0_12px_2px_rgb(224_163_60/0.8)]" />
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-4 md:flex-none">
        <div className="flex flex-col gap-[3px]">
          <span className="text-ink font-serif text-[21px] leading-[1.1] font-semibold">
            {x.who}
          </span>
          <span className="text-muted text-[12px]">{x.kind}</span>
        </div>
        <Stars n={st.stars ?? 0} size={17} id={x.id} dull={st.auditStale} />
        <p
          className={cn(
            "m-0 font-serif text-[16px] leading-[1.4] text-pretty italic",
            st.quote ? "text-ink" : "text-muted",
          )}
        >
          {st.quote
            ? `“${st.quote}”`
            : running
              ? "Reading the codebase…"
              : "Waiting to be summoned."}
        </p>
        <div className="grow" />
        {running ? (
          <div className="border-hairline flex flex-col gap-1.5 border-t pt-2.5">
            <span className="text-terracotta-deep flex items-center gap-1.5 font-mono text-[10px]">
              <span className="bg-terracotta size-1.5 animate-[dotPulse_1s_ease-in-out_infinite] rounded-full" />
              {st.running?.log.at(-1) ?? "Waking up"}
            </span>
            <span className="bg-column block h-1 overflow-hidden rounded-sm">
              <span
                className="bg-terracotta block h-1 transition-[width] duration-600 ease-linear"
                style={{ width: `${((step + 1) / steps.length) * 100}%` }}
              />
            </span>
          </div>
        ) : (
          <div className="border-hairline flex items-center gap-2 border-t pt-2.5">
            {st.error ? (
              <span
                className="text-crimson-chip-text line-clamp-2 text-[11px]"
                title={st.error}
              >
                Last run failed
              </span>
            ) : done ? (
              <span className="text-muted font-mono text-[10px]">
                Audited {ago(st.at, now)}
              </span>
            ) : st.rubric && !locked ? (
              <span className="text-muted text-[11px]">Calibrated</span>
            ) : locked ? (
              <span className="text-muted text-[11px]">
                Unlocks at Lv {x.unlockLevel}
              </span>
            ) : (
              <span className="text-muted text-[11px]">Counts as 0★</span>
            )}
            <span className="grow" />
            {!locked && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSummon(x.id);
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md text-[12px] font-semibold active:scale-[0.96]",
                  done
                    ? "border-line bg-cream text-ink hover:border-terracotta h-7 border px-2.5"
                    : "bg-anthracite text-cream h-[30px] px-3",
                )}
              >
                {!done && <PlayIcon size={10} />}
                {summonLabel(st)}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const SECTIONS: Array<{
  key: "likes" | "dislikes" | "wrong" | "missing";
  title: string;
  ink: string;
}> = [
  { key: "likes", title: "What works", ink: "var(--jade)" },
  { key: "dislikes", title: "What doesn't", ink: "var(--terracotta)" },
  { key: "wrong", title: "What's wrong", ink: "var(--crimson)" },
  { key: "missing", title: "What's missing", ink: "var(--dot-idle)" },
];

function Report({
  x,
  st,
  now,
  locked,
  onSummon,
}: {
  x: Sentinel;
  st: SentinelState;
  now: number;
  locked: boolean;
  onSummon: (kind: AuditKind) => void;
}) {
  const running = !!st.running;
  const done = st.stars !== null && !!st.report;
  const first = x.who.split(" ").at(-1);
  const meta = running
    ? `${x.name} · ${st.running!.kind === "calibrate" ? "calibrating" : "auditing"}…`
    : st.stars !== null
      ? `${x.name} · ${st.stars} of 5 · ${ago(st.at, now)}`
      : `${x.name} · not audited`;
  const prompt = useMemo(() => promptFor(x), [x]);
  // The report an Epic was just made from, until the store brings st.epicId.
  const reportKey = `${x.id}@${st.at}`;
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [epicError, setEpicError] = useState<string | null>(null);
  const sent = !!st.epicId || createdKey === reportKey;
  const noGaps = st.stars === 5;
  const capped = !!st.rubric && !!st.report && cappedByFindings(st.rubric.rubric, st.report);

  async function createEpic() {
    setSending(true);
    setEpicError(null);
    const res = await fetch(`/api/sentinels/${x.id}/epic`, {
      method: "POST",
    }).catch(() => null);
    setSending(false);
    if (res?.ok) setCreatedKey(reportKey);
    else
      setEpicError(
        ((await res?.json().catch(() => null)) as { error?: string } | null)
          ?.error ?? "Could not create the epic.",
      );
  }

  return (
    <aside
      aria-label="Audit report"
      data-tour="sentinel-report"
      className="border-line bg-card box-border flex flex-col gap-[18px] rounded-[14px] border p-5 pt-12"
    >
      <div className="flex items-center gap-3">
        <span
          className="relative size-[52px] shrink-0 overflow-hidden rounded-full"
          style={{ background: portraitGround(x.id) }}
        >
          <Portrait id={x.id} />
        </span>
        <div className="flex min-w-0 grow flex-col gap-[3px]">
          <span className="font-serif text-[21px] leading-[1.1] font-semibold">
            {x.who}
          </span>
          <span className="text-muted font-mono text-[10px] uppercase">
            {meta}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onSummon(st.rubric ? "audit" : "calibrate")}
          disabled={running || locked}
          className="border-line bg-cream text-ink hover:border-terracotta h-8 shrink-0 rounded-lg border px-3 text-[12px] font-semibold whitespace-nowrap active:scale-[0.96] disabled:opacity-60"
        >
          {running ? "Running…" : locked ? `Lv ${x.unlockLevel}` : summonLabel(st)}
        </button>
      </div>

      {st.error && !running && (
        <p
          role="status"
          className="bg-crimson-chip text-crimson-chip-text m-0 rounded-lg px-3.5 py-2.5 text-[13px] leading-[1.45]"
        >
          {st.error}
          {st.stars !== null || st.rubric ? " What was saved before still counts." : ""}
        </p>
      )}

      {running && (
        <div className="bg-anthracite flex flex-col gap-2 rounded-[10px] px-4 py-3.5">
          {(st.running!.log.length ? st.running!.log : ["Waking up"]).map(
            (t, i, all) => {
              const past = i < all.length - 1;
              return (
                <span
                  key={`${i}-${t}`}
                  className="sentinel-motion flex animate-[sentinelLine_240ms_ease-out] gap-2 font-mono text-[11px] leading-normal"
                  style={{
                    color: past ? "var(--dot-idle)" : "var(--log-text)",
                  }}
                >
                  <span aria-hidden>{past ? "✓" : "›"}</span>
                  {t}
                </span>
              );
            },
          )}
        </div>
      )}

      {done && (
        <div className="flex flex-col gap-[18px]">
          <div className="bg-panel flex flex-col gap-2 rounded-[10px] px-4 py-3.5">
            <Stars n={st.stars ?? 0} size={20} dull={st.auditStale} />
            {st.auditStale && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted text-[13px]">
                  Much has changed. Shall we re-audit?
                </span>
                <button
                  type="button"
                  onClick={() => onSummon("audit")}
                  disabled={running || locked}
                  className="border-line bg-cream text-ink hover:border-terracotta h-8 rounded-lg border px-3 text-[12px] font-semibold whitespace-nowrap active:scale-[0.96] disabled:opacity-60"
                >
                  Re-audit
                </button>
              </div>
            )}
            {capped && (
              <p className="text-muted m-0 text-[12px] leading-[1.45]">
                These stars are capped by the findings listed below, not by a rubric failure.
              </p>
            )}
            <p className="text-ink m-0 font-serif text-[17px] leading-[1.4] text-pretty">
              {st.summary}
            </p>
          </div>
          <Ladder
            st={st}
            now={now}
            busy={running || locked}
            onCalibrate={() => onSummon("calibrate")}
          />
          {SECTIONS.map((sec) => (
            <Section
              key={sec.key}
              title={sec.title}
              ink={sec.ink}
              items={st.report![sec.key]}
            />
          ))}
          {st.files.length > 0 && (
            <details className="text-muted text-[12px]">
              <summary className="cursor-pointer">
                Read {st.files.length} file{st.files.length === 1 ? "" : "s"}
                {st.model && st.model !== "mock" ? ` · ${st.model}` : ""}
              </summary>
              <ul className="m-0 mt-2 flex list-none flex-col gap-0.5 p-0 font-mono text-[10px]">
                {st.files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => void createEpic()}
              disabled={noGaps || running || sending || sent}
              title={
                noGaps
                  ? "A 5-star report leaves nothing to fix."
                  : running
                    ? "An audit is running."
                    : undefined
              }
              className="bg-anthracite text-cream h-9 self-start rounded-lg px-3.5 text-[13px] font-semibold active:scale-[0.97] disabled:opacity-50"
            >
              {sent ? "Epic created" : "Create epic from this report"}
            </button>
            {createdKey === reportKey && (
              <span role="status" className="text-muted text-[12px]">
                Epic added to Backlog.
              </span>
            )}
            {epicError && (
              <span role="alert" className="text-crimson-chip-text text-[12px]">
                {epicError}
              </span>
            )}
          </div>
        </div>
      )}

      {!done && st.rubric && (
        <Ladder
          st={st}
          now={now}
          busy={running || locked}
          onCalibrate={() => onSummon("calibrate")}
        />
      )}

      {!done && !running && (
        <div className="border-line-dashed flex flex-col gap-3 rounded-[10px] border border-dashed p-4">
          <span className="text-muted text-[13px] leading-normal text-pretty">
            {locked
              ? `${x.who} unlocks at colony Lv ${x.unlockLevel}, and counts toward the grade from then.`
              : st.rubric
                ? `${x.who} has a rubric for this project. Audit to score the code against it; until then this seat adds zero stars to the grade.`
                : `${x.who} hasn't calibrated on this project yet. Calibrating reads the project and writes the checks each star needs, so every audit after it is scored the same way.`}
          </span>
          <button
            type="button"
            onClick={() => onSummon(st.rubric ? "audit" : "calibrate")}
            disabled={locked}
            className="bg-anthracite text-cream inline-flex h-9 disabled:opacity-50 items-center gap-2 self-start rounded-lg px-3.5 text-[13px] font-semibold active:scale-[0.97]"
          >
            <PlayIcon size={12} />
            {st.rubric ? "Audit" : "Calibrate"} {first}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-muted font-mono text-[9px] tracking-[0.12em]">
          PROMPT
        </span>
        <p className="bg-panel text-muted m-0 rounded-lg px-3.5 py-3 font-mono text-[11px] leading-[1.6] text-pretty">
          {prompt}
        </p>
      </div>
    </aside>
  );
}

/** What the next summon does: calibrate first, then audit against the rubric. */
function summonLabel(st: SentinelState): string {
  if (!st.rubric) return "Calibrate";
  return st.stars !== null && st.scoredWith ? "Re-audit" : "Audit";
}

/**
 * The sentinel's rubric for this project: the checks each star needs, marked
 * with how the last audit scored them, and the way to write it again.
 */
function Ladder({
  st,
  now,
  busy,
  onCalibrate,
}: {
  st: SentinelState;
  now: number;
  busy: boolean;
  onCalibrate: () => void;
}) {
  const rubric = st.rubric?.rubric ?? st.scoredWith;
  // Marks only where the checks are the ones the last audit was scored on.
  const scored = !st.rubricChanged && st.scoredWith ? st.report?.checks : undefined;
  const marks = new Map((scored ?? []).map((c) => [c.id, c]));
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="bg-clay size-2 rounded-[2px]" />
        <span className="text-ink text-[11px] font-bold tracking-[0.08em] uppercase">
          Rubric
        </span>
        {st.rubric?.at && (
          <span className="text-muted font-mono text-[10px]">
            calibrated {ago(st.rubric.at, now)}
          </span>
        )}
        <span className="grow" />
        <button
          type="button"
          onClick={onCalibrate}
          disabled={busy}
          title="Reads the project again and writes a new rubric. Audits after it are scored against the new one."
          className="border-line bg-cream text-ink hover:border-terracotta h-7 rounded-md border px-2.5 text-[12px] font-semibold active:scale-[0.96] disabled:opacity-60"
        >
          {st.rubric ? "Recalibrate" : "Calibrate"}
        </button>
      </div>
      {!rubric ? (
        <span className="text-muted pl-4 text-[13px] leading-normal text-pretty">
          These stars were given before rubrics. Calibrate to write the checks
          each star needs, then audit to be scored against them.
        </span>
      ) : (
        <>
          <span className="text-muted pl-4 text-[13px] leading-normal text-pretty">
            {rubric.context} Each star needs all of its checks and every star
            below it.
          </span>
          {st.rubricChanged && (
            <span className="text-muted pl-4 text-[12px] leading-normal text-pretty italic">
              The stars above were scored against an earlier rubric. Audit
              again to be scored against this one.
            </span>
          )}
          {rubric.rungs.map((r) => (
            <div key={r.stars} className="flex flex-col gap-1.5 pl-4">
              <span className="flex items-center gap-2">
                <Stars n={r.stars} size={12} />
              </span>
              {r.checks.map((k) => {
                const m = marks.get(k.id);
                return (
                  <div
                    key={k.id}
                    className="border-hairline flex gap-2 border-b pb-1.5"
                  >
                    <span
                      aria-label={m ? (m.met ? "Met" : "Not met") : "Not scored"}
                      className="w-3 shrink-0 text-[12px] leading-[1.45] font-bold"
                      style={{
                        color: m
                          ? m.met
                            ? "var(--jade)"
                            : "var(--crimson)"
                          : "var(--dot-idle)",
                      }}
                    >
                      {m ? (m.met ? "✓" : "✗") : "·"}
                    </span>
                    <span className="flex min-w-0 flex-col gap-[2px]">
                      <span className="text-ink text-[13px] leading-[1.45] text-pretty">
                        {k.text}
                      </span>
                      <span className="text-muted text-[11px] leading-[1.4] text-pretty">
                        {m?.evidence || k.how}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Section({
  title,
  ink,
  items,
}: {
  title: string;
  ink: string;
  items: AuditPoint[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-[2px]" style={{ background: ink }} />
        <span className="text-ink text-[11px] font-bold tracking-[0.08em] uppercase">
          {title}
        </span>
        <span className="text-muted font-mono text-[10px]">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <span className="text-muted pl-4 text-[13px]">Nothing flagged</span>
      ) : (
        items.map((it, i) => (
          <div
            key={i}
            className="border-hairline flex flex-col gap-[3px] border-b pb-2 pl-4"
          >
            <span className="text-ink text-[13px] leading-[1.45] text-pretty">
              {it.text}
            </span>
            {it.ref && (
              <span className="text-terracotta-deep font-mono text-[10px] break-all">
                {it.ref}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}
