"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { useColony, type ColonyApi } from "@/components/colony/colony";
import { centerOf } from "@/components/colony/fx";
import { GRADES, GRADE_RULE, gradeRose } from "@/lib/sentinels/grade";
import { GROUP_INK, SENTINELS, promptFor, stepsFor, type Sentinel } from "@/lib/sentinels/roster";
import type { SentinelState } from "@/lib/sentinels/view";
import type { AuditPoint } from "@/lib/db/repository";
import { PORTRAITS, portraitGround } from "./portraits";
import { useSentinels, type SentinelsApi } from "./store";

/** The level badge's octagon, chamfered for an 84px grade. */
const BIG_OCT =
  "polygon(22px 0,calc(100% - 22px) 0,100% 22px,100% calc(100% - 22px),calc(100% - 22px) 100%,22px 100%,0 calc(100% - 22px),0 22px)";

const STAR = "M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 11.9l-4.2 2.3.8-4.7L1.2 6.2l4.7-.7z";

function Stars({ n, size, id }: { n: number; size: number; id?: string }) {
  return (
    <span className="flex gap-0.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} data-star={id} width={size} height={size} viewBox="0 0 16 16">
          <path d={STAR} fill={i < n ? "var(--clay)" : "var(--border)"} />
        </svg>
      ))}
    </span>
  );
}

function Portrait({ pic, className }: { pic: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("absolute inset-0 block", className)}
      dangerouslySetInnerHTML={{
        __html: `<svg viewBox="0 0 200 200" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" style="display:block">${PORTRAITS[pic] ?? ""}</svg>`,
      }}
    />
  );
}

function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3.5 2.2v9.6L11.5 7z" fill="var(--clay-lit)" />
    </svg>
  );
}

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
export function SentinelsPage({ repoName }: { repoName: string }) {
  const c = useColony();
  const s = useSentinels();
  if (!c?.sentinelsOpen || !s) return null;
  return <SentinelsView c={c} s={s} repoName={repoName} />;
}

function SentinelsView({ c, s, repoName }: { c: ColonyApi; s: SentinelsApi; repoName: string }) {
  const root = useRef<HTMLDivElement>(null);
  const gradeRef = useRef<HTMLSpanElement>(null);
  const [sel, setSel] = useState<string>(SENTINELS[0]!.id);
  const [now, setNow] = useState(() => Date.now());
  const g = s.grade;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") c.setSentinelsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    root.current?.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], {
      duration: 260,
      easing: "cubic-bezier(.2,.8,.2,1)",
    });
    return () => {
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
      const els = root.current?.querySelectorAll<SVGElement>(`[data-star="${x.id}"]`) ?? [];
      for (let i = 0; i < stars; i++) {
        setTimeout(() => {
          c.sfx("blip", i * 2 + 7);
          if (!reduce)
            els[i]?.animate(
              [{ transform: "scale(0.2) rotate(-40deg)" }, { transform: "scale(1.45)" }, { transform: "scale(1)" }],
              { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" },
            );
        }, i * 110);
      }
      const card = root.current?.querySelector<HTMLElement>(`[data-card="${x.id}"]`);
      if (card && !reduce)
        card.animate([{ transform: "none" }, { transform: "translateY(-8px)" }, { transform: "none" }], {
          duration: 420,
          easing: "cubic-bezier(.2,.8,.2,1)",
        });
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
            ? [{ transform: "rotateY(0) scale(1)" }, { transform: "rotateY(360deg) scale(1.2)" }, { transform: "rotateY(360deg) scale(1)" }]
            : [{ transform: "none" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "none" }],
          { duration: up ? 700 : 360, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
        if (up) {
          const [x, y] = centerOf(el);
          c.fx.ring(x, y, g.ink, 60, 0.5, 3);
          c.fx.burst(x, y, [g.ink, "var(--clay-lit)"], 18, { speed: 180, g: 220, size: 2, life: 0.6, shape: "dot" });
        }
      }, 700);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.states]);

  const nBusy = SENTINELS.filter((x) => s.states[x.id]?.running).length;
  const summon = (id: string) => {
    setSel(id);
    c.sfx("emerge");
    void s.summon(id);
  };
  const selected = SENTINELS.find((x) => x.id === sel)!;

  return (
    <div
      ref={root}
      role="region"
      aria-label="Sentinels"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 z-[60] box-border overflow-auto px-4 pt-5 pb-6 md:top-16 md:px-6 lg:overflow-hidden"
    >
      <div className="mx-auto flex max-w-[1640px] flex-col gap-4 lg:h-full">
        <section className="border-line bg-card flex shrink-0 flex-wrap items-center gap-6 rounded-[14px] border px-6 py-5">
          <span
            ref={gradeRef}
            title={GRADE_RULE}
            className="text-cream inline-flex size-[84px] shrink-0 flex-col items-center justify-center gap-0.5 transition-[background] duration-400"
            style={{ background: g.ink, clipPath: BIG_OCT }}
          >
            <span className="font-mono text-[9px] tracking-[0.14em] opacity-80">GRADE</span>
            <span className="font-serif text-[42px] leading-none font-semibold">{g.grade}</span>
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Colony audit · {repoName}</span>
            <h1 className="m-0 font-serif text-[30px] leading-none font-semibold tracking-[-0.01em]">Sentinels</h1>
            <span className="text-muted max-w-[440px] text-[13px] text-pretty">
              Twelve agents read the codebase against their own brief and rate it. Unaudited sentinels count as zero
              stars.
            </span>
          </div>
          <div className="grow" />
          <div className="flex flex-col items-start gap-2">
            <div className="flex gap-1">
              {GRADES.map((x) => {
                const on = x.grade === g.grade;
                return (
                  <span
                    key={x.grade}
                    title={x.min ? `${x.grade} · avg ≥ ${x.min.toFixed(1)}` : `${x.grade} · below 2.0`}
                    className="oct inline-flex p-px"
                    style={{ background: on ? x.ink : "var(--border)" }}
                  >
                    <span
                      className="oct inline-flex size-[30px] items-center justify-center font-serif text-[15px] font-semibold transition-colors duration-300"
                      style={{ background: on ? x.ink : "var(--card)", color: on ? "var(--cream)" : "var(--dot-idle)" }}
                    >
                      {x.grade}
                    </span>
                  </span>
                );
              })}
            </div>
            <div className="flex items-baseline gap-2.5">
              <span className="text-ink font-mono text-[12px] font-medium">{g.avg.toFixed(2)} / 5 avg</span>
              <span className="text-muted text-[12px]">
                {g.done} of {g.total} reported
              </span>
            </div>
            <span className="bg-line block h-1 w-[238px] overflow-hidden rounded-sm">
              <span
                className="bg-clay block h-1 transition-[width] duration-700 ease-[cubic-bezier(.2,.8,.2,1)]"
                style={{ width: `${g.progress * 100}%` }}
              />
            </span>
            <span className="text-muted text-[12px]">
              {g.next
                ? `${g.next.grade} at ${g.next.min.toFixed(1)} avg · ${g.next.need} more star${g.next.need === 1 ? "" : "s"}`
                : "Top grade reached"}
            </span>
          </div>
          <span aria-hidden className="bg-line w-px self-stretch max-lg:hidden" />
          <button
            type="button"
            onClick={() => {
              c.sfx("emerge");
              s.summonAll();
            }}
            disabled={nBusy === SENTINELS.length}
            className="bg-anthracite text-cream inline-flex h-11 items-center gap-2.5 rounded-[10px] px-[18px] text-[14px] font-semibold transition-transform active:scale-[0.97] disabled:opacity-70"
          >
            <PlayIcon />
            {nBusy ? `Auditing ${nBusy}…` : `Summon all ${SENTINELS.length}`}
          </button>
        </section>

        {s.refusal && (
          <p role="alert" className="bg-crimson-chip text-crimson-chip-text m-0 rounded-lg px-4 py-2.5 text-[13px]">
            {s.refusal}
          </p>
        )}

        <div className="flex gap-4 max-lg:flex-col lg:min-h-0 lg:flex-1">
          <Rail s={s} sel={sel} now={now} onSelect={(id) => { c.sfx("blip", 5); setSel(id); }} onSummon={summon} />
          <Report x={selected} st={s.states[selected.id]!} now={now} onSummon={() => summon(selected.id)} />
        </div>
      </div>
    </div>
  );
}

function Rail({
  s,
  sel,
  now,
  onSelect,
  onSummon,
}: {
  s: SentinelsApi;
  sel: string;
  now: number;
  onSelect: (id: string) => void;
  onSummon: (id: string) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  // A mouse wheel scrolls the rail sideways.
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={rail}
      role="list"
      aria-label="Sentinels"
      className="flex min-w-0 flex-1 snap-x snap-proximity gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-2 max-lg:min-h-[520px]"
    >
      {SENTINELS.map((x) => (
        <Card key={x.id} x={x} st={s.states[x.id]!} on={sel === x.id} now={now} onSelect={onSelect} onSummon={onSummon} />
      ))}
    </div>
  );
}

function Card({
  x,
  st,
  on,
  now,
  onSelect,
  onSummon,
}: {
  x: Sentinel;
  st: SentinelState;
  on: boolean;
  now: number;
  onSelect: (id: string) => void;
  onSummon: (id: string) => void;
}) {
  const running = !!st.running;
  const done = !running && st.stars !== null;
  const steps = stepsFor(x);
  const step = st.running?.log.length ? st.running.log.length - 1 : 0;
  return (
    <div
      role="listitem"
      data-card={x.id}
      tabIndex={0}
      aria-label={`${x.who}, ${x.name}. ${st.stars !== null ? `${st.stars} of 5 stars` : "Not audited"}`}
      aria-current={on || undefined}
      onClick={() => onSelect(x.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(x.id);
        }
      }}
      className={cn(
        "bg-card focus-visible:border-terracotta flex w-[264px] shrink-0 cursor-pointer snap-start flex-col overflow-hidden rounded-[14px] border outline-none transition-[border-color,box-shadow] hover:shadow-[0_14px_28px_-20px_rgb(28_25_23/0.55)]",
        on ? "border-terracotta shadow-[0_0_0_3px_rgb(217_107_39/0.14)]" : "border-line",
      )}
    >
      <div className="relative h-[46%] min-h-[180px] shrink-0 overflow-hidden" style={{ background: portraitGround(x.pic) }}>
        <div className={cn("absolute inset-0", running && "sentinel-motion animate-[sentinelBob_0.9s_ease-in-out_infinite]")}>
          <Portrait pic={x.pic} />
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
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-4">
        <div className="flex flex-col gap-[3px]">
          <span className="text-ink font-serif text-[21px] leading-[1.1] font-semibold">{x.who}</span>
          <span className="text-muted text-[12px]">{x.kind}</span>
        </div>
        <Stars n={st.stars ?? 0} size={17} id={x.id} />
        <p className={cn("m-0 font-serif text-[16px] leading-[1.4] text-pretty italic", st.quote ? "text-ink" : "text-muted")}>
          {st.quote ? `“${st.quote}”` : running ? "Reading the codebase…" : "Waiting to be summoned."}
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
              <span className="text-crimson-chip-text line-clamp-2 text-[11px]" title={st.error}>
                Last run failed
              </span>
            ) : done ? (
              <span className="text-muted font-mono text-[10px]">Audited {ago(st.at, now)}</span>
            ) : (
              <span className="text-muted text-[11px]">Counts as 0★</span>
            )}
            <span className="grow" />
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
              {done ? "Re-run" : "Summon"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const SECTIONS: Array<{ key: "likes" | "dislikes" | "wrong" | "missing"; title: string; ink: string }> = [
  { key: "likes", title: "What works", ink: "var(--jade)" },
  { key: "dislikes", title: "What doesn't", ink: "var(--terracotta)" },
  { key: "wrong", title: "What's wrong", ink: "var(--crimson)" },
  { key: "missing", title: "What's missing", ink: "var(--dot-idle)" },
];

function Report({ x, st, now, onSummon }: { x: Sentinel; st: SentinelState; now: number; onSummon: () => void }) {
  const running = !!st.running;
  const done = st.stars !== null && !!st.report;
  const first = x.who.split(" ").at(-1);
  const meta = running
    ? `${x.name} · auditing…`
    : st.stars !== null
      ? `${x.name} · ${st.stars} of 5 · ${ago(st.at, now)}`
      : `${x.name} · not audited`;
  const prompt = useMemo(() => promptFor(x), [x]);

  return (
    <aside
      aria-label="Audit report"
      className="border-line bg-card box-border flex shrink-0 flex-col gap-[18px] rounded-[14px] border p-5 lg:min-h-0 lg:w-[420px] lg:overflow-auto"
    >
      <div className="flex items-center gap-3">
        <span className="relative size-[52px] shrink-0 overflow-hidden rounded-full" style={{ background: portraitGround(x.pic) }}>
          <Portrait pic={x.pic} />
        </span>
        <div className="flex min-w-0 grow flex-col gap-[3px]">
          <span className="font-serif text-[21px] leading-[1.1] font-semibold">{x.who}</span>
          <span className="text-muted font-mono text-[10px] uppercase">{meta}</span>
        </div>
        <button
          type="button"
          onClick={onSummon}
          disabled={running}
          className="border-line bg-cream text-ink hover:border-terracotta h-8 rounded-lg border px-3 text-[12px] font-semibold active:scale-[0.96] disabled:opacity-60"
        >
          {running ? "Running…" : st.stars !== null ? "Re-run" : "Summon"}
        </button>
      </div>

      {st.error && !running && (
        <p role="status" className="bg-crimson-chip text-crimson-chip-text m-0 rounded-lg px-3.5 py-2.5 text-[13px] leading-[1.45]">
          {st.error}
          {st.stars !== null ? " The last report below still counts." : ""}
        </p>
      )}

      {running && (
        <div className="bg-anthracite flex flex-col gap-2 rounded-[10px] px-4 py-3.5">
          {(st.running!.log.length ? st.running!.log : ["Waking up"]).map((t, i, all) => {
            const past = i < all.length - 1;
            return (
              <span
                key={`${i}-${t}`}
                className="sentinel-motion flex animate-[sentinelLine_240ms_ease-out] gap-2 font-mono text-[11px] leading-normal"
                style={{ color: past ? "var(--dot-idle)" : "var(--log-text)" }}
              >
                <span aria-hidden>{past ? "✓" : "›"}</span>
                {t}
              </span>
            );
          })}
        </div>
      )}

      {done && (
        <div className="flex flex-col gap-[18px]">
          <div className="bg-panel flex flex-col gap-2 rounded-[10px] px-4 py-3.5">
            <Stars n={st.stars ?? 0} size={20} />
            <p className="text-ink m-0 font-serif text-[17px] leading-[1.4] text-pretty">{st.summary}</p>
          </div>
          {SECTIONS.map((sec) => (
            <Section key={sec.key} title={sec.title} ink={sec.ink} items={st.report![sec.key]} />
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
        </div>
      )}

      {!done && !running && (
        <div className="border-line-dashed flex flex-col gap-3 rounded-[10px] border border-dashed p-4">
          <span className="text-muted text-[13px] leading-normal text-pretty">
            {x.who} hasn&apos;t audited this project yet, so this seat adds zero stars to the grade.
          </span>
          <button
            type="button"
            onClick={onSummon}
            className="bg-anthracite text-cream inline-flex h-9 items-center gap-2 self-start rounded-lg px-3.5 text-[13px] font-semibold active:scale-[0.97]"
          >
            <PlayIcon size={12} />
            Summon {first}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-muted font-mono text-[9px] tracking-[0.12em]">PROMPT</span>
        <p className="bg-panel text-muted m-0 rounded-lg px-3.5 py-3 font-mono text-[11px] leading-[1.6] text-pretty">{prompt}</p>
      </div>
    </aside>
  );
}

function Section({ title, ink, items }: { title: string; ink: string; items: AuditPoint[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-[2px]" style={{ background: ink }} />
        <span className="text-ink text-[11px] font-bold tracking-[0.08em] uppercase">{title}</span>
        <span className="text-muted font-mono text-[10px]">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <span className="text-muted pl-4 text-[13px]">Nothing flagged</span>
      ) : (
        items.map((it, i) => (
          <div key={i} className="border-hairline flex flex-col gap-[3px] border-b pb-2 pl-4">
            <span className="text-ink text-[13px] leading-[1.45] text-pretty">{it.text}</span>
            {it.ref && <span className="text-terracotta-deep font-mono text-[10px] break-all">{it.ref}</span>}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The project's grade in the header, before the level: an outlined octagon
 * in the grade's colour. Opens the Sentinels.
 */
export function GradeBadge({ compact = false }: { compact?: boolean }) {
  const c = useColony();
  const s = useSentinels();
  if (!c || !s) return null;
  const g = s.grade;
  const busy = SENTINELS.some((x) => s.states[x.id]?.running);
  return (
    <button
      type="button"
      data-colony="grade"
      onClick={() => c.setSentinelsOpen(!c.sentinelsOpen)}
      aria-expanded={c.sentinelsOpen}
      aria-label={`Audit grade ${g.grade}, ${g.avg.toFixed(1)} of 5 from ${g.done} of ${g.total} sentinels. ${c.sentinelsOpen ? "Back to board" : "Open sentinels"}`}
      title={`Sentinels · grade ${g.grade} · ${g.avg.toFixed(2)} avg`}
      className="oct-lg relative inline-flex shrink-0 p-[1.5px] transition-transform hover:scale-[1.06] active:scale-[0.94]"
      style={{ background: g.ink }}
    >
      <span
        className={cn(
          "oct-lg bg-cream inline-flex flex-col items-center justify-center gap-px",
          compact ? "size-[29px]" : "size-[33px]",
        )}
        style={{ color: g.ink }}
      >
        <span className={cn("font-mono tracking-[0.1em]", compact ? "text-[6px]" : "text-[7px]")}>AUDIT</span>
        <span className={cn("font-serif leading-none font-semibold", compact ? "text-[14px]" : "text-[16px]")}>{g.grade}</span>
      </span>
      {busy && (
        <span className="bg-clay-lit absolute top-1 right-1 size-1.5 animate-[dotPulse_1s_ease-in-out_infinite] rounded-full" />
      )}
    </button>
  );
}

/** The labelled way into the Sentinels, beside the Timeline's. */
export function SentinelsButton() {
  const c = useColony();
  const s = useSentinels();
  if (!c || !s) return null;
  const open = c.sentinelsOpen;
  const busy = SENTINELS.filter((x) => s.states[x.id]?.running).length;
  return (
    <button
      type="button"
      onClick={() => c.setSentinelsOpen(!open)}
      aria-label={open ? "Back to board" : "Open sentinels"}
      aria-expanded={open}
      className="border-line bg-card text-ink hover:border-terracotta inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border pr-3 pl-2.5 text-[13px] font-semibold transition-[border-color,box-shadow] hover:shadow-[0_6px_14px_-10px_color-mix(in_srgb,var(--anthracite)_40%,transparent)] active:scale-[0.97] max-lg:hidden"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M7 1.2 12 3v3.6c0 3-2.1 5.2-5 6.2-2.9-1-5-3.2-5-6.2V3z" fill="var(--text)" />
        <path d="m4.8 7 1.5 1.5L9.4 5.4" stroke="var(--clay-lit)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {open ? "Board" : "Sentinels"}
      {open ? (
        <span className="border-line text-muted rounded border px-[5px] py-0.5 font-mono text-[9px] font-medium">ESC</span>
      ) : busy ? (
        <span className="text-terracotta-deep flex items-center gap-1 font-mono text-[10px] font-medium">
          <span className="bg-terracotta size-1.5 animate-[dotPulse_1s_ease-in-out_infinite] rounded-full" />
          {busy}
        </span>
      ) : (
        <span className="font-serif text-[14px] leading-none" style={{ color: s.grade.ink }}>
          {s.grade.grade}
        </span>
      )}
    </button>
  );
}
