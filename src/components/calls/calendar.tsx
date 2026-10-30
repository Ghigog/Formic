"use client";

import { cn } from "@/components/ui/cn";
import { occurrencesBetween } from "@/lib/calls/occurrences";
import type { Meeting } from "@/lib/db/repository";

/** The hours a day offers to start a meeting in. */
const HOURS = Array.from({ length: 10 }, (_, i) => i + 8);
const DAYS = 14;

/** The Monday of the week `date` falls in, at midnight. */
export function weekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const dayLabel = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Two weeks of hourly slots, each week in one of the board's column wells.
 * An empty slot opens the form for its time; a meeting opens its call.
 */
export function Calendar({
  meetings,
  from,
  onPick,
  onOpen,
}: {
  meetings: Meeting[];
  from: Date;
  onPick: (at: Date) => void;
  onOpen?: (meetingId: string) => void;
}) {
  const days = Array.from({ length: DAYS }, (_, i) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + i));
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + DAYS);
  const occurrences = occurrencesBetween(meetings, from, to);
  const today = new Date();

  return (
    <div className="grid gap-5">
      {[days.slice(0, 7), days.slice(7)].map((week, w) => (
        <section key={week[0]!.toISOString()} aria-label={w === 0 ? "This week" : "Next week"} className="bg-column rounded-xl p-3">
          <h2 className="text-muted mb-2 px-1 text-[11px] font-semibold tracking-[0.1em] uppercase">{w === 0 ? "This week" : "Next week"}</h2>
          <div className="overflow-x-auto">
            <div className="grid min-w-[620px] grid-cols-[3rem_repeat(7,minmax(0,1fr))] gap-1.5">
              <div />
              {week.map((d) => {
                const isToday = sameDay(d, today);
                const weekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <div key={d.toISOString()} className="flex flex-col items-center gap-0.5 pb-1">
                    <span className={cn("font-mono text-[10px] tracking-[0.08em] uppercase", isToday ? "text-terracotta-cta" : "text-muted")}>
                      {d.toLocaleDateString("en-GB", { weekday: "short" })}
                    </span>
                    <span
                      className={cn(
                        "inline-flex size-7 items-center justify-center rounded-full font-serif text-[15px] font-semibold",
                        isToday ? "bg-terracotta-cta text-white" : weekend ? "text-muted" : "text-ink",
                      )}
                    >
                      {d.getDate()}
                    </span>
                  </div>
                );
              })}
              {HOURS.map((h) => (
                <div key={h} className="contents">
                  <div className="text-muted pt-1.5 pr-1 text-right font-mono text-[10px]">{hourLabel(h)}</div>
                  {week.map((d) => {
                    const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h);
                    const here = occurrences.filter((o) => sameDay(o.at, d) && o.at.getHours() === h);
                    const weekend = d.getDay() === 0 || d.getDay() === 6;
                    return (
                      <div key={d.toISOString()} className="min-h-9">
                        {here.length === 0 ? (
                          <button
                            type="button"
                            aria-label={`${dayLabel(d)} ${hourLabel(h)}`}
                            onClick={() => onPick(slot)}
                            className={cn(
                              "group border-line hover:border-terracotta flex h-full min-h-9 w-full items-center justify-center rounded-md border transition-colors",
                              weekend ? "bg-nested-muted" : "bg-card",
                            )}
                          >
                            <span aria-hidden className="text-terracotta text-[15px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                              +
                            </span>
                          </button>
                        ) : (
                          here.map((o) => (
                            <button
                              key={o.meeting.id}
                              type="button"
                              onClick={() => onOpen?.(o.meeting.id)}
                              title={o.meeting.title}
                              className="bg-epic-chip text-epic-chip-text border-terracotta flex min-h-9 w-full flex-col justify-center rounded-md border-l-[3px] px-1.5 text-left"
                            >
                              <span className="truncate text-[11px] leading-tight font-semibold">{o.meeting.title}</span>
                              {o.meeting.repeat !== "none" && <span className="font-mono text-[9px] opacity-75">repeats</span>}
                            </button>
                          ))
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
