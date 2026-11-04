"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useColony } from "@/components/colony/colony";
import { AutoTour } from "@/components/onboarding/tour";
import { centerOf } from "@/components/colony/fx";
import { useMeetings } from "@/lib/hooks/use-meetings";
import { upNext } from "@/lib/meetings/due";
import { guestOptions } from "@/lib/meetings/guests";
import { Calendar, visibleOccurrences, weekStart } from "./calendar";
import { plopSchedule } from "./entrance";
import { MeetingCard } from "./meeting-card";
import { MeetingForm } from "./meeting-form";
import { UpNext } from "./up-next";

/** The next quarter hour, the slot New meeting starts in. */
function nextSlot(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0);
  return d;
}

/** The Meetings menu, over the board in the Timeline's frame. */
export function MeetingsMenu({ repoName, unlockAllSentinels = false }: { repoName: string; unlockAllSentinels?: boolean }) {
  const c = useColony();
  if (!c?.meetingsOpen) return null;
  return <MeetingsView repoName={repoName} level={c.score.level} unlockAll={unlockAllSentinels} close={() => c.setMeetingsOpen(false)} />;
}

type Panel = { kind: "form"; at: Date; editing?: string } | { kind: "card"; id: string; at: Date } | null;

function MeetingsView({ repoName, level, unlockAll, close }: { repoName: string; level: number; unlockAll: boolean; close: () => void }) {
  const c = useColony();
  const { meetings, loaded, error, create, update, remove } = useMeetings();
  const [now] = useState(() => new Date());
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const entered = useRef(false);
  const guests = useMemo(() => guestOptions(level, unlockAll), [level, unlockAll]);
  const next = upNext(meetings, now);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The page drops in, with a squash and a settle.
  useEffect(() => {
    if (!c || c.fx.reducedMotion) return;
    c.sfx("drop");
    root.current?.animate(
      [
        { opacity: 0, transform: "translateY(-28px) scale(1, 1.03)" },
        { opacity: 1, transform: "translateY(0) scale(1.02, 0.96)", offset: 0.6 },
        { opacity: 1, transform: "translateY(0) scale(0.995, 1.01)", offset: 0.82 },
        { opacity: 1, transform: "none" },
      ],
      { duration: 420, easing: "cubic-bezier(.3,.7,.3,1)" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the meetings are in: the days wave in, each meeting plops into its
  // day in time order, then Up next rings and its coins fan out. Reduced
  // motion shows it all at once and only Up next rings.
  useEffect(() => {
    const el = root.current;
    if (!c || !el || !loaded || entered.current) return;
    entered.current = true;
    const hasNext = Boolean(el.querySelector("[data-mnext]"));
    if (c.fx.reducedMotion) {
      if (hasNext) c.sfx("ring");
      return;
    }
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const later = (ms: number, f: () => void) => timers.push(setTimeout(f, ms));
    const ease = "cubic-bezier(.2,.9,.3,1.3)";

    // Days wave in left to right, silently.
    const days = [...el.querySelectorAll<HTMLElement>("[data-mday]")];
    days.forEach((d, i) =>
      d.animate(
        [
          { opacity: 0, transform: "translateY(-8px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 260, delay: 160 + (i % 7) * 45, easing: ease, fill: "backwards" },
      ),
    );
    const start = 160 + 6 * 45 + 260;

    const ripple = (target: Element) => {
      const [x, y] = centerOf(target);
      c.fx.ring(x, y, "var(--terracotta)", 34, 0.5, 2);
    };
    const fall = (target: Element, delay: number, pitch: number) => {
      target.animate(
        [
          { opacity: 0, transform: "translateY(-26px) scale(0.9, 1.1)" },
          { opacity: 1, transform: "translateY(0) scale(1.14, 0.8)", offset: 0.6 },
          { opacity: 1, transform: "scale(0.96, 1.06)", offset: 0.8 },
          { opacity: 1, transform: "none" },
        ],
        { duration: 380, delay, easing: "ease-in", fill: "backwards" },
      );
      later(delay + 230, () => {
        c.sfx("plop", pitch);
        ripple(target);
      });
    };

    const plops = plopSchedule(visibleOccurrences(meetings, weekStart(now)));
    for (const p of plops) {
      const target = el.querySelector(`[data-mocc="${p.key}"]`);
      if (target) fall(target, start + p.delay, p.pitch);
    }
    let end = start + (plops.length ? plops[plops.length - 1]!.delay + 380 : 0);
    if (plops.length === 0) {
      const today = el.querySelector("[data-mtoday]");
      if (today) fall(today, start, 0.5);
      end = start + 380;
    }

    const next = el.querySelector<HTMLElement>("[data-mnext]");
    later(end, () => {
      if (!next) return;
      c.sfx("ring");
      next.animate(
        [
          { transform: "rotate(0)" },
          { transform: "rotate(-1.2deg)" },
          { transform: "rotate(1deg)" },
          { transform: "rotate(-0.6deg)" },
          { transform: "none" },
        ],
        { duration: 520, easing: "ease-in-out" },
      );
      next.querySelectorAll<HTMLElement>("[data-mcoin]").forEach((coin, i) =>
        coin.animate(
          [
            { transform: "translateX(-18px) scale(0.4)", opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
          { duration: 320, delay: 120 + i * 60, easing: ease, fill: "backwards" },
        ),
      );
    });
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const card = panel?.kind === "card" ? meetings.find((m) => m.id === panel.id) : undefined;
  const editing = panel?.kind === "form" && panel.editing ? meetings.find((m) => m.id === panel.editing) : undefined;

  return (
    <div
      ref={root}
      role="region"
      aria-label="Meetings"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 z-[60] box-border overflow-auto px-4 pt-5 pb-8 md:top-16 md:px-6"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Ceremonies · {repoName}</span>
            <h1 className="m-0 font-serif text-[28px] leading-none font-semibold tracking-[-0.01em]">Meetings</h1>
          </div>
          <button
            type="button"
            data-tour="meetings-new"
            onClick={() => setPanel({ kind: "form", at: nextSlot(new Date()) })}
            className="bg-terracotta-cta inline-flex h-9 items-center rounded-lg px-3.5 text-[13px] font-semibold text-white"
          >
            New meeting
          </button>
        </div>

        {error && (
          <p role="alert" className="bg-crimson/10 text-ink rounded-md px-3 py-2 text-[13px]">
            {error}
          </p>
        )}

        {panel?.kind === "form" && (
          <MeetingForm
            key={`${panel.at.getTime()}-${panel.editing ?? ""}`}
            at={panel.at}
            meeting={editing}
            guests={guests}
            onCancel={() => setPanel(null)}
            onSave={async (input) => {
              if (panel.editing) await update(panel.editing, input);
              else await create(input);
              setPanel(null);
            }}
          />
        )}

        {card && panel?.kind === "card" && (
          <MeetingCard
            meeting={card}
            at={panel.at}
            busy={busy}
            error={deleteError}
            onClose={() => setPanel(null)}
            onEdit={() => setPanel({ kind: "form", at: card.startsAt, editing: card.id })}
            onDelete={async () => {
              setBusy(true);
              setDeleteError(null);
              try {
                await remove(card.id);
                setPanel(null);
              } catch (e) {
                setDeleteError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}

        {next ? (
          <UpNext next={next} />
        ) : (
          <p data-tour="meetings-empty" className="text-muted border-line rounded-xl border border-dashed p-6 text-center text-[14px]">
            No meetings yet. Let&apos;s plan one.
          </p>
        )}

        <Calendar
          meetings={meetings}
          from={weekStart(now)}
          onPick={(at) => setPanel({ kind: "form", at })}
          onOpen={(id, at) => setPanel({ kind: "card", id, at })}
        />
      </div>
      <AutoTour id="meetings" delay={450} />
    </div>
  );
}
