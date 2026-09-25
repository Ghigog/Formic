"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { levelOf, rankOf } from "@/lib/colony/game";
import { WINDOW_DAYS as N, TODAY, buildTimeline, type TimelineTicket } from "@/lib/colony/timeline";
import { useColony, type ColonyApi } from "./colony";
import { centerOf } from "./fx";

const pct = (d: number) => `${(Math.max(0, Math.min(N, d)) / N) * 100}%`;

const TICKET_LOOK: Record<TimelineTicket["phase"], { bg: string; border: string; anim: string; dot: string }> = {
  done: { bg: "var(--text-muted)", border: "none", anim: "none", dot: "var(--text-muted)" },
  review: {
    bg: "repeating-linear-gradient(45deg,var(--terracotta) 0 6px,var(--terracotta-lit) 6px 12px)",
    border: "none",
    anim: "tlStripe 1.4s linear infinite",
    dot: "var(--terracotta)",
  },
  progress: {
    bg: "repeating-linear-gradient(45deg,var(--clay) 0 6px,var(--clay-lit) 6px 12px)",
    border: "none",
    anim: "tlStripe 0.8s linear infinite",
    dot: "var(--clay)",
  },
  planned: { bg: "transparent", border: "1.5px dashed var(--dot-idle)", anim: "none", dot: "var(--border-dashed)" },
};

const GRADE_CHIP = {
  S: ["var(--clay-chip)", "var(--clay-chip-text)"],
  A: ["var(--jade-chip)", "var(--jade-chip-text)"],
  B: ["var(--hairline)", "var(--text)"],
  C: ["var(--crimson-chip)", "var(--crimson-chip-text)"],
} as const;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      style={{ transform: `rotate(${open ? 90 : 0}deg)`, transition: "transform 180ms cubic-bezier(.2,.8,.2,1)" }}
    >
      <path d="M3.5 2 6.5 5 3.5 8" stroke="var(--text)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The roadmap: a burndown of story points across the window, each epic as a
 * bar with its tickets under it, merges per day, and where the colony
 * levelled up. Covers the board between the header and the ambient bar.
 */
export function ColonyTimeline({ repoName }: { repoName: string }) {
  const c = useColony();
  if (!c?.timelineOpen) return null;
  return <TimelineView c={c} repoName={repoName} />;
}

function TimelineView({ c, repoName }: { c: ColonyApi; repoName: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // One "now" per opening, so the model does not churn under the animation.
  const [at] = useState(() => new Date());
  const tl = useMemo(() => buildTimeline(c.cards, at), [c.cards, at]);

  const fmt = (d: number) => {
    const day = new Date(tl.start.getFullYear(), tl.start.getMonth(), tl.start.getDate() + Math.floor(d));
    return day.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") c.setTimelineOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The entrance: bars grow, the burndown draws, mounds pop, grades stamp.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], {
      duration: 260,
      easing: "cubic-bezier(.2,.8,.2,1)",
    });
    if (c.fx.reducedMotion) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const scale = [0, 2, 4, 7, 9];
    const bars = el.querySelectorAll<HTMLElement>("[data-tlbar]");
    bars.forEach((b, i) => {
      const d = 140 + i * 38;
      b.animate(
        [
          { transform: "scaleX(0)", opacity: 0.4 },
          { transform: "scaleX(1.04)", opacity: 1, offset: 0.75 },
          { transform: "scaleX(1)" },
        ],
        { duration: 420, delay: d, easing: "cubic-bezier(.2,.9,.3,1)", fill: "backwards" },
      );
      timers.push(setTimeout(() => c.sfx("blip", scale[i % 5]! + 12 * Math.floor(i / 5) - 5), d + 60));
    });
    el.querySelector("[data-tlreveal]")?.animate(
      [{ clipPath: "inset(-40px 100% -40px 0)" }, { clipPath: "inset(-40px 0 -40px 0)" }],
      { duration: 1000, delay: 120, easing: "cubic-bezier(.45,0,.2,1)", fill: "backwards" },
    );
    el.querySelectorAll("[data-tlmound]").forEach((m, i) =>
      m.animate(
        [{ transform: "scaleY(0)" }, { transform: "scaleY(1.15)", offset: 0.7 }, { transform: "scaleY(1)" }],
        { duration: 380, delay: 260 + i * 22, easing: "ease-out", fill: "backwards" },
      ),
    );
    const stamps = [...el.querySelectorAll<HTMLElement>("[data-tlstamp]")];
    const t0 = 180 + bars.length * 38 + 200;
    stamps.forEach((st, i) => {
      const d = t0 + i * 220;
      st.animate(
        [
          { transform: "rotate(-24deg) scale(2.6)", opacity: 0 },
          { transform: "rotate(-4deg) scale(0.9)", opacity: 1, offset: 0.6 },
          { transform: "rotate(-6deg) scale(1)" },
        ],
        { duration: 300, delay: d, easing: "cubic-bezier(.5,0,.8,.4)", fill: "backwards" },
      );
      timers.push(
        setTimeout(() => {
          const color = st.dataset.color ?? "var(--clay)";
          c.sfx("stamp");
          c.fx.shake(2);
          const [x, y] = centerOf(st);
          c.fx.ring(x, y, color, 36, 0.35, 2);
          c.fx.burst(x, y, [color, "var(--text)"], 8, { speed: 120, g: 200, size: 1.6, life: 0.45, shape: "dot" });
        }, d + 180),
      );
    });
    const fc = el.querySelector("[data-tlforecast]");
    timers.push(
      setTimeout(() => {
        fc?.animate([{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], {
          duration: 320,
          easing: "cubic-bezier(.2,.9,.3,1.4)",
        });
        c.sfx("blip", 19);
      }, t0 + stamps.length * 220 + 80),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = Math.max(1, tl.total);
  const X = (d: number) => (Math.max(0, Math.min(N, d)) / N) * 1000;
  const Y = (r: number) => (1 - r / total) * 200;
  const poly = (p: Array<[number, number]>) => p.map(([d, r]) => `${X(d).toFixed(1)},${Y(r).toFixed(1)}`).join(" ");
  const fEnd: [number, number] | null =
    tl.forecast === null ? null : tl.forecast <= N ? [tl.forecast, 0] : [N, Math.max(0, tl.remaining - tl.velocity * (N - tl.now))];

  const remAfter = (d: number) => tl.days[d]?.remaining ?? tl.remaining;
  const startLevel = levelOf(c.score.earned) - tl.levels.length;
  const yieldText =
    tl.yieldRatio === null ? "No merges yet" : `${tl.yieldRatio.toFixed(2)}×`;
  const daysLeft = tl.forecast === null ? null : Math.max(0, tl.forecast - tl.now);

  const rows: Array<
    | { kind: "epic"; e: (typeof tl.epics)[number]; open: boolean }
    | { kind: "ticket"; t: TimelineTicket }
  > = [];
  for (const e of tl.epics) {
    const open = !closed.has(e.id);
    rows.push({ kind: "epic", e, open });
    if (open) for (const t of e.tickets) rows.push({ kind: "ticket", t });
  }
  const toggle = (id: string) => {
    const opening = closed.has(id);
    c.sfx(opening ? "pickup" : "drop");
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const streakFrom = tl.days[TODAY]!.sp > 0 ? TODAY - tl.streak + 1 : TODAY - tl.streak;
  const streakTo = tl.days[TODAY]!.sp > 0 ? TODAY : TODAY - 1;
  const streakText =
    tl.days[TODAY]!.sp > 0
      ? `${tl.streak}-day merge streak.${tl.bestDay !== null ? ` Best day was ${fmt(tl.bestDay)}.` : ""}`
      : tl.streak
        ? `${tl.streak}-day merge streak. Merge today to make it ${tl.streak + 1}.`
        : "No streak yet. Merge today to start one.";

  let hoverA = "";
  let hoverB = "";
  if (hover !== null) {
    const day = tl.days[hover]!;
    if (hover < TODAY) {
      hoverA = `${remAfter(hover)} SP left`;
      hoverB = day.sp ? `${day.sp} SP → +${day.pts} pts` : "No merges";
    } else if (hover === TODAY) {
      hoverA = `${tl.remaining} SP left · today`;
      hoverB = day.sp ? `${day.sp} SP merged so far` : "Nothing merged yet";
    } else {
      hoverA = `~${Math.max(0, Math.round(tl.remaining - tl.velocity * (hover + 1 - tl.now)))} SP left`;
      hoverB = "Projected at current pace";
    }
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const d = Math.max(0, Math.min(N - 1, Math.floor(((e.clientX - r.left) / r.width) * N)));
    if (d !== hover) {
      setHover(d);
      c.sfx("scrub", d);
    }
  };

  return (
    <div
      ref={root}
      role="region"
      aria-label="Timeline"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 md:top-16 z-[60] box-border overflow-auto px-6 pt-5 pb-8"
    >
      <div className="mx-auto flex max-w-[1520px] min-w-[960px] flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Roadmap · {repoName}</span>
            <h1 className="m-0 font-serif text-[28px] leading-none font-semibold tracking-[-0.01em]">Timeline</h1>
          </div>
          <span className="text-muted pb-[3px] text-[13px]">
            {fmt(0)} – {fmt(N - 1)} · {tl.epics.length} epic{tl.epics.length === 1 ? "" : "s"}
          </span>
          <div className="flex-grow" />
          <div className="text-muted flex items-center gap-3.5 pb-1 text-[11px]">
            <Legend swatch={{ background: "var(--text-muted)" }}>Merged</Legend>
            <Legend swatch={{ background: "repeating-linear-gradient(45deg,var(--terracotta) 0 4px,var(--terracotta-lit) 4px 8px)" }}>In review</Legend>
            <Legend swatch={{ background: "repeating-linear-gradient(45deg,var(--clay) 0 4px,var(--clay-lit) 4px 8px)" }}>In progress</Legend>
            <Legend swatch={{ border: "1.5px dashed var(--dot-idle)", boxSizing: "border-box" }}>Planned</Legend>
            <span
              title="Grade = points earned ÷ story points merged, with the epic bonus. S ≥ 2.5×, A ≥ 2.0×, B ≥ 1.5×, C below."
              className="inline-flex items-center gap-1.5"
            >
              <span className="h-3 w-0.5 bg-[color-mix(in_srgb,var(--anthracite)_35%,transparent)]" />
              Level up
            </span>
          </div>
        </div>

        <div className="border-line bg-card grid grid-cols-[300px_minmax(0,1fr)] overflow-hidden rounded-xl border">
          {/* Left: the burndown's numbers and the row labels. */}
          <div className="border-line flex min-w-0 flex-col border-r">
            <div className="border-line box-border flex h-11 shrink-0 items-center justify-between border-b px-4">
              <span className="text-[11px] font-semibold tracking-[0.1em] uppercase">Burndown</span>
              <span className="text-muted font-mono text-[10px]">{tl.total} SP</span>
            </div>
            <div className="border-line box-border flex h-[232px] shrink-0 flex-col gap-3 border-b p-4">
              <div className="flex flex-col gap-1">
                <span className="text-muted font-mono text-[9px] tracking-[0.12em]">FORECAST FINISH</span>
                <div className="flex items-center gap-2.5">
                  <span data-tlforecast className="inline-block font-serif text-[30px] leading-none font-semibold tracking-[-0.01em]">
                    {tl.forecast === null ? "—" : fmt(tl.forecast)}
                  </span>
                  {daysLeft !== null && (
                    <span className="oct inline-flex bg-line p-px">
                      <span className="oct bg-cream text-ink inline-flex px-2 py-[3px] font-mono text-[10px] tracking-[0.04em]">
                        {tl.remaining === 0 ? "All merged" : daysLeft < 1 ? "Today" : `in ${Math.ceil(daysLeft)}d`}
                      </span>
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Stat k="Velocity" v={`${tl.velocity.toFixed(1)} SP/day`} />
                <Stat k="Remaining" v={`${tl.remaining} of ${tl.total} SP`} />
                <Stat k="Colony yield" v={yieldText} />
                <Stat
                  k="Level"
                  v={tl.levels.length ? `Lv ${startLevel} → Lv ${c.score.level}` : `Lv ${c.score.level}`}
                />
              </div>
              {tl.boost && (
                <div className="bg-epic-chip text-terracotta-deep flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] leading-[1.35]">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
                    <path d="M6.8 1 2.5 7h3l-.6 4L9.5 5h-3z" fill="var(--terracotta)" />
                  </svg>
                  <span>
                    Merge {tl.boost.key} to pull the finish in by {tl.boost.days.toFixed(1)} days
                  </span>
                </div>
              )}
            </div>

            {rows.map((r) =>
              r.kind === "epic" ? (
                <div key={r.e.id} className="bg-card box-border flex h-[52px] items-center gap-2 border-t border-hairline pr-3 pl-2">
                  <button
                    type="button"
                    onClick={() => toggle(r.e.id)}
                    aria-label={`${r.open ? "Collapse" : "Expand"} ${r.e.key}`}
                    aria-expanded={r.open}
                    className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-md hover:bg-hairline"
                  >
                    <Chevron open={r.open} />
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-muted font-mono text-[9px] tracking-[0.06em]">
                      {r.e.key} · {r.e.doneSp}/{r.e.totalSp} SP
                    </span>
                    <span className="truncate font-serif text-[15px] font-semibold">{r.e.title}</span>
                  </div>
                  {r.e.merged && r.e.grade ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-muted font-mono text-[9px]">{r.e.yieldRatio!.toFixed(1)}× yield</span>
                      <span
                        data-tlstamp
                        data-color={r.e.grade.color}
                        title={`${r.e.key} merged · ${r.e.yieldRatio!.toFixed(1)}× yield`}
                        className="oct inline-flex size-7 rotate-[-6deg] items-center justify-center font-serif text-[16px] font-semibold text-white"
                        style={{ background: r.e.grade.color }}
                      >
                        {r.e.grade.grade}
                      </span>
                    </div>
                  ) : (
                    <span
                      className="shrink-0 rounded-full px-[7px] py-[3px] font-mono text-[9px] whitespace-nowrap"
                      style={{
                        background: r.e.grade ? GRADE_CHIP[r.e.grade.grade][0] : "var(--hairline)",
                        color: r.e.grade ? GRADE_CHIP[r.e.grade.grade][1] : "var(--text-muted)",
                      }}
                    >
                      {r.e.grade ? `${r.e.yieldRatio!.toFixed(1)}× · ${r.e.grade.grade} pace` : "No merges yet"}
                    </span>
                  )}
                </div>
              ) : (
                <div key={r.t.id} className="box-border flex h-[34px] items-center gap-2 pr-3 pl-[42px]">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: TICKET_LOOK[r.t.phase].dot }} />
                  <span className="text-muted shrink-0 font-mono text-[10px]">{r.t.key}</span>
                  <span className={`min-w-0 flex-1 truncate text-[12px] ${r.t.phase === "planned" ? "text-muted" : "text-ink"}`}>
                    {r.t.title}
                  </span>
                  <span className="text-muted shrink-0 font-mono text-[10px]">{r.t.sp} SP</span>
                </div>
              ),
            )}
            {rows.length === 0 && (
              <div className="text-muted border-t border-hairline px-4 py-4 text-[12px]">
                No epics with tickets yet. Once the Architect Agent breaks one down, it lands here.
              </div>
            )}

            <div className="border-line box-border flex h-[88px] shrink-0 flex-col justify-center gap-1 border-t px-4">
              <span className="text-[11px] font-semibold tracking-[0.1em] uppercase">Daily merges</span>
              <span className="text-muted text-[12px] leading-[1.35]">{streakText}</span>
            </div>
          </div>

          {/* Right: the calendar. */}
          <div onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="relative flex min-w-0 flex-col">
            <div aria-hidden className="pointer-events-none absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${N}, minmax(0,1fr))` }}>
              {tl.days.map((d, i) => {
                const wk = d.date.getDay() === 0 || d.date.getDay() === 6;
                return (
                  <span
                    key={i}
                    className="border-r border-hairline transition-colors duration-100"
                    style={{
                      background:
                        hover === i
                          ? "color-mix(in srgb, var(--anthracite) 5%, transparent)"
                          : i === TODAY
                            ? "color-mix(in srgb, var(--clay) 8%, transparent)"
                            : wk
                              ? "color-mix(in srgb, var(--anthracite) 2.5%, transparent)"
                              : "transparent",
                    }}
                  />
                );
              })}
            </div>

            <div
              className="border-line relative box-border grid h-11 shrink-0 border-b"
              style={{ gridTemplateColumns: `repeat(${N}, minmax(0,1fr))` }}
            >
              {tl.days.map((d, i) => {
                const isT = i === TODAY;
                return (
                  <div key={i} className="flex flex-col items-center justify-center gap-0.5">
                    <span
                      className="font-mono text-[8px] tracking-[0.08em]"
                      style={{ color: isT ? "var(--terracotta-deep)" : "var(--text-muted)" }}
                    >
                      {i === 0 || d.date.getDate() === 1
                        ? d.date.toLocaleDateString("en-US", { month: "short" }).toUpperCase()
                        : "SMTWTFS"[d.date.getDay()]}
                    </span>
                    <span
                      className="font-mono text-[11px]"
                      style={{ fontWeight: isT ? 700 : 500, color: isT ? "var(--terracotta-deep)" : i > TODAY ? "var(--text-muted)" : "var(--text)" }}
                    >
                      {d.date.getDate()}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="border-line relative box-border h-[232px] shrink-0 border-b">
              <span className="text-muted absolute top-3 left-1.5 font-mono text-[9px]">{tl.total}</span>
              <span className="text-muted absolute bottom-3 left-1.5 font-mono text-[9px]">0</span>
              <div data-tlreveal className="absolute inset-x-0 top-5 bottom-5">
                <svg viewBox="0 0 1000 200" preserveAspectRatio="none" width="100%" height="100%" aria-hidden className="block overflow-visible">
                  <polygon points={`${poly(tl.actual)} ${X(tl.now).toFixed(1)},200 0,200`} fill="color-mix(in srgb, var(--clay) 9%, transparent)" />
                  {fEnd && (
                    <polyline
                      points={poly([[tl.now, tl.remaining], fEnd])}
                      fill="none"
                      stroke="var(--terracotta)"
                      strokeWidth="2"
                      strokeDasharray="1 6"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  <polyline
                    points={poly(tl.actual)}
                    fill="none"
                    stroke="var(--text)"
                    strokeWidth="2.25"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                {tl.epics
                  .filter((e) => e.merged && e.grade)
                  .map((e) => {
                    const md = Math.min(TODAY, Math.max(...e.tickets.map((t) => t.mergedDay ?? TODAY)));
                    const fx = md >= TODAY ? tl.now : md + 1;
                    const y = (Y(md >= TODAY ? tl.remaining : remAfter(md)) / 200) * 100;
                    return (
                      <span
                        key={e.id}
                        title={`${e.key} merged ${fmt(md)}`}
                        className="absolute flex -translate-x-1/2 translate-y-[calc(-100%-6px)] flex-col items-center"
                        style={{ left: pct(fx), top: `${y}%` }}
                      >
                        <span
                          className="inline-flex size-5 items-center justify-center font-serif text-[12px] font-semibold text-white [clip-path:polygon(5px_0,calc(100%-5px)_0,100%_5px,100%_calc(100%-5px),calc(100%-5px)_100%,5px_100%,0_calc(100%-5px),0_5px)]"
                          style={{ background: e.grade!.color }}
                        >
                          {e.grade!.grade}
                        </span>
                        <span className="h-1.5 w-px" style={{ background: e.grade!.color }} />
                      </span>
                    );
                  })}
                {fEnd && (
                  <>
                    <span
                      className="absolute box-border size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-terracotta bg-white"
                      style={{ left: pct(fEnd[0]), top: `${(Y(fEnd[1]) / 200) * 100}%` }}
                    />
                    <span
                      className="bg-epic-chip text-terracotta-deep absolute -translate-x-1/2 -translate-y-[150%] rounded px-1.5 py-0.5 font-mono text-[9px] whitespace-nowrap"
                      style={{ left: pct(fEnd[0]), top: `${(Y(fEnd[1]) / 200) * 100}%` }}
                    >
                      {tl.forecast! <= N ? `DONE ${fmt(tl.forecast!).toUpperCase()}` : "PAST RANGE"}
                    </span>
                  </>
                )}
                <span className="absolute size-0" style={{ left: pct(tl.now), top: `${(Y(tl.remaining) / 200) * 100}%` }}>
                  <span className="bg-clay absolute -top-[9px] -left-[9px] size-[18px] animate-[tlPing_1.8s_ease-out_infinite] rounded-full motion-reduce:hidden" />
                  <span className="bg-anthracite absolute -top-[5px] -left-[5px] box-border size-2.5 rounded-full border-2 border-white shadow-[0_1px_3px_color-mix(in_srgb,var(--anthracite)_40%,transparent)]" />
                </span>
              </div>
            </div>

            {rows.map((r) =>
              r.kind === "epic" ? (
                <div key={r.e.id} className="relative box-border h-[52px] border-t border-hairline">
                  <span
                    data-tlbar
                    className="absolute top-[17px] h-4 origin-left overflow-hidden rounded-md bg-track"
                    style={{ left: pct(r.e.start), width: pct(Math.max(0.35, r.e.end - r.e.start)) }}
                  >
                    <span
                      className="block h-full rounded-md transition-[width] duration-700"
                      style={{
                        width: `${r.e.totalSp ? (r.e.doneSp / r.e.totalSp) * 100 : 0}%`,
                        background: r.e.merged ? "var(--jade)" : "var(--text)",
                      }}
                    />
                  </span>
                  {r.e.merged && (
                    <span
                      className="bg-jade absolute top-[15px] inline-flex size-5 -translate-x-1/2 items-center justify-center [clip-path:polygon(5px_0,calc(100%-5px)_0,100%_5px,100%_calc(100%-5px),calc(100%-5px)_100%,5px_100%,0_calc(100%-5px),0_5px)]"
                      style={{ left: pct(r.e.end) }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="m2.2 5.2 1.8 1.8 3.8-4" stroke="var(--on-accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </div>
              ) : (
                <div key={r.t.id} className="relative box-border h-[34px]">
                  <span
                    data-tlbar
                    title={`${r.t.key} · ${
                      r.t.phase === "done"
                        ? `Merged ${fmt(r.t.mergedDay!)}`
                        : r.t.phase === "review"
                          ? "In review"
                          : r.t.phase === "progress"
                            ? "In progress"
                            : `Planned ${fmt(r.t.start)} – ${fmt(r.t.end - 1)}`
                    }`}
                    className="absolute top-[11px] box-border h-3 origin-left rounded motion-reduce:!animate-none"
                    style={{
                      left: pct(r.t.start),
                      width: pct(
                        Math.max(0.35, (r.t.phase === "progress" || r.t.phase === "review" ? tl.now : r.t.end) - r.t.start),
                      ),
                      background: TICKET_LOOK[r.t.phase].bg,
                      backgroundSize: "17px 17px",
                      border: TICKET_LOOK[r.t.phase].border,
                      animation: TICKET_LOOK[r.t.phase].anim,
                    }}
                  />
                </div>
              ),
            )}
            {rows.length === 0 && <div className="h-[49px] border-t border-hairline" />}

            <div
              className="border-line relative box-border grid h-[88px] shrink-0 items-end border-t pb-3.5"
              style={{ gridTemplateColumns: `repeat(${N}, minmax(0,1fr))` }}
            >
              {tl.days.map((d, i) => {
                const inStreak = i >= streakFrom && i <= streakTo && tl.streak > 0;
                return (
                  <div
                    key={i}
                    title={d.sp ? `${fmt(i)} · ${d.sp} SP → +${d.pts} pts` : fmt(i)}
                    className="flex flex-col items-center justify-end gap-1"
                  >
                    <span className="font-mono text-[9px]" style={{ color: inStreak ? "var(--terracotta-deep)" : "var(--text-muted)" }}>
                      {d.sp || ""}
                    </span>
                    <span
                      data-tlmound
                      className="block w-[72%] origin-bottom rounded-[999px_999px_2px_2px]"
                      style={{
                        height: d.sp ? `${Math.min(46, 8 + d.sp * 3.8)}px` : i <= TODAY ? "3px" : "0px",
                        background: !d.sp ? "var(--border)" : i === TODAY ? "var(--terracotta)" : inStreak ? "var(--clay)" : "var(--dot-idle)",
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {tl.levels.map((lv) => (
              <span key={lv.level}>
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-11 bottom-0 w-0 border-l-[1.5px] border-[color-mix(in_srgb,var(--anthracite)_22%,transparent)]"
                  style={{ left: pct(lv.day) }}
                />
                <span
                  title={`Reached Lv ${lv.level} · ${rankOf(lv.level)}`}
                  className="bg-anthracite text-cream absolute top-[250px] -translate-x-1/2 px-[7px] py-[3px] font-mono text-[9px] tracking-[0.08em] whitespace-nowrap [clip-path:polygon(5px_0,calc(100%-5px)_0,100%_5px,100%_calc(100%-5px),calc(100%-5px)_100%,5px_100%,0_calc(100%-5px),0_5px)]"
                  style={{ left: pct(lv.day) }}
                >
                  LV {lv.level}
                </span>
              </span>
            ))}

            <div
              aria-hidden
              className="pointer-events-none absolute top-0 bottom-0 -ml-px w-0.5 bg-[color-mix(in_srgb,var(--clay)_55%,transparent)]"
              style={{ left: pct(tl.now) }}
            />
            <span
              aria-hidden
              className="bg-clay pointer-events-none absolute top-12 -translate-x-1/2 rounded px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] text-white"
              style={{ left: pct(tl.now) }}
            >
              NOW
            </span>

            {hover !== null && (
              <>
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-11 bottom-0 w-px bg-[color-mix(in_srgb,var(--anthracite)_30%,transparent)]"
                  style={{ left: pct(hover + 0.5) }}
                />
                <div
                  className="bg-anthracite text-cream pointer-events-none absolute top-[72px] flex flex-col gap-0.5 rounded-lg px-2.5 py-2 whitespace-nowrap shadow-[0_10px_20px_-12px_color-mix(in_srgb,var(--anthracite)_60%,transparent)]"
                  style={{
                    left: pct(hover + 0.5),
                    transform: hover > N - 7 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
                  }}
                >
                  <span className="text-[12px] font-semibold">
                    {tl.days[hover]!.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                  </span>
                  <span className="font-mono text-[10px] text-line-dashed">{hoverA}</span>
                  <span className="text-clay-lit font-mono text-[10px]">{hoverB}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend({ swatch, children }: { swatch: React.CSSProperties; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-4 rounded-[3px]" style={swatch} />
      {children}
    </span>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted text-[12px]">{k}</span>
      <span className="text-ink font-mono text-[12px]">{v}</span>
    </div>
  );
}
