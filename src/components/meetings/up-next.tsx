"use client";

import { useRef } from "react";
import type { Occurrence } from "@/lib/meetings/occurrences";
import { GuestCoin } from "./guest-coin";
import { JoinNow } from "./join-meeting";

const AGENDA_LINES = 3;

export const whenLabel = (d: Date) =>
  d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The next meeting: title, time, who is coming, the top of the agenda and the way in. */
export function UpNext({ next, onJoined }: { next: Occurrence; onJoined?: () => void }) {
  const coins = useRef<HTMLDivElement>(null);
  const { meeting, at } = next;
  const lines = meeting.agenda.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <section
      data-tour="meetings-next"
      data-mnext
      aria-label="Up next"
      className="border-line bg-card flex flex-wrap items-start gap-x-6 gap-y-3 rounded-xl border p-4"
    >
      <div className="grid min-w-0 flex-1 basis-64 gap-1.5">
        <span className="text-terracotta-deep font-mono text-[10px] tracking-[0.12em] uppercase">Up next</span>
        <h2 className="text-ink m-0 font-serif text-[22px] leading-tight font-semibold">{meeting.title}</h2>
        <time dateTime={at.toISOString()} className="text-muted font-mono text-[12px]">
          {whenLabel(at)}
        </time>
        {lines.length > 0 && (
          <ul className="text-ink m-0 mt-1 grid list-disc gap-0.5 pl-4 text-[13px] leading-5">
            {lines.slice(0, AGENDA_LINES).map((l, i) => (
              <li key={i} className="truncate">
                {l}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-4 self-end">
        {meeting.guests.length > 0 && (
          <div ref={coins} className="flex -space-x-1.5">
            {meeting.guests.map((g) => (
              <span key={g} data-mcoin className="inline-flex">
                <GuestCoin id={g} size={28} />
              </span>
            ))}
          </div>
        )}
        <JoinNow
          meeting={meeting}
          source={() => coins.current}
          onJoined={onJoined}
          className="bg-terracotta-cta inline-flex h-9 items-center rounded-lg px-3.5 text-[13px] font-semibold text-white"
        />
      </div>
    </section>
  );
}
