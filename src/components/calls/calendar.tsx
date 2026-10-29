"use client";

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

/** Two weeks of hourly slots; an empty slot opens the form for its time. */
export function Calendar({
  meetings,
  from,
  onPick,
}: {
  meetings: Meeting[];
  from: Date;
  onPick: (at: Date) => void;
}) {
  const days = Array.from({ length: DAYS }, (_, i) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + i));
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + DAYS);
  const occurrences = occurrencesBetween(meetings, from, to);

  return (
    <div className="grid gap-4">
      {[days.slice(0, 7), days.slice(7)].map((week) => (
        <div key={week[0]!.toISOString()} className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] gap-px text-xs">
          <div />
          {week.map((d) => (
            <div key={d.toISOString()} className="text-muted p-1 text-center font-medium">
              {dayLabel(d)}
            </div>
          ))}
          {HOURS.map((h) => (
            <div key={h} className="contents">
              <div className="text-muted p-1 text-right">{hourLabel(h)}</div>
              {week.map((d) => {
                const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h);
                const here = occurrences.filter(
                  (o) => o.at.getFullYear() === d.getFullYear() && o.at.getMonth() === d.getMonth() && o.at.getDate() === d.getDate() && o.at.getHours() === h,
                );
                return (
                  <div key={d.toISOString()} className="border-line bg-card min-h-8 border">
                    {here.length === 0 ? (
                      <button
                        type="button"
                        aria-label={`${dayLabel(d)} ${hourLabel(h)}`}
                        onClick={() => onPick(slot)}
                        className="hover:bg-line/40 h-full min-h-8 w-full"
                      />
                    ) : (
                      here.map((o) => (
                        <div key={o.meeting.id} className="bg-clay/20 truncate px-1 py-0.5" title={o.meeting.title}>
                          {o.meeting.title}
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
