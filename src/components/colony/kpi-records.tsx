"use client";

import { useEffect, useRef, useState } from "react";
import { useColony } from "./colony";
import { useSound } from "./store";
import { days, prefersReducedMotion } from "./kpi-chart";
import type { Records } from "@/lib/kpi/compute";

const RECENT_MS = 7 * 86_400_000;
const STAMP_DELAY_MS = 150;

/** The last record values this browser has seen, per board. */
interface Seen {
  bestWeek?: number;
  longestRun?: number;
  fastestTicket?: number;
}
type Key = keyof Seen;

interface Badge {
  key: Key;
  label: string;
  detail: string;
  value: number;
  /** When the record was set, as an ISO date or time. */
  at: string;
}

function badges(r: Records): Badge[] {
  const out: Badge[] = [];
  if (r.bestWeek) {
    const n = r.bestWeek.count;
    out.push({
      key: "bestWeek",
      label: "Best week",
      detail: `${n} done`,
      value: n,
      at: r.bestWeek.achievedAt,
    });
  }
  if (r.longestRun) {
    const n = r.longestRun.days;
    out.push({
      key: "longestRun",
      label: "Longest run",
      detail: n === 1 ? "1 day" : `${n} days`,
      value: n,
      at: r.longestRun.endsOn,
    });
  }
  if (r.fastestTicket) {
    const t = r.fastestTicket;
    out.push({
      key: "fastestTicket",
      label: "Fastest ticket",
      detail: `${t.ticket.key} · ${days(t.days)}`,
      value: t.days,
      at: t.doneAt,
    });
  }
  return out;
}

const beats = (key: Key, value: number, stored: number | undefined) =>
  stored === undefined ||
  (key === "fastestTicket" ? value < stored : value > stored);

function read(storage: string): Seen | null {
  try {
    const raw = window.localStorage.getItem(storage);
    return raw ? (JSON.parse(raw) as Seen) : null;
  } catch {
    return null;
  }
}

/** Which records are new to this browser: beating the stored value, or, with nothing stored, set in the last 7 days. */
function freshKeys(list: Badge[], storage: string): Set<Key> {
  const seen = read(storage);
  const now = Date.now();
  return new Set(
    list
      .filter((b) =>
        seen
          ? beats(b.key, b.value, seen[b.key])
          : now - new Date(b.at).getTime() <= RECENT_MS,
      )
      .map((b) => b.key),
  );
}

/**
 * Best week, longest run and fastest ticket as stamps. A record new to this
 * browser stamps in once, `settled` (the tiles have counted up) having come;
 * the values are then stored so a reload shows it still.
 */
export function KpiRecords({
  records,
  settled,
}: {
  records: Records;
  settled: boolean;
}) {
  const c = useColony();
  const [soundOn] = useSound();
  const storage = `${c?.storageKey ?? "formic:colony"}:kpi-records`;
  const list = badges(records);
  const [fresh] = useState(() => freshKeys(list, storage));
  const ref = useRef<HTMLUListElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!settled || done.current) return;
    done.current = true;
    const stamps = [
      ...(ref.current?.querySelectorAll<HTMLElement>("[data-kpistamp]") ?? []),
    ].filter((el) => fresh.has(el.dataset.kpistamp as Key));
    if (
      stamps.length &&
      !prefersReducedMotion() &&
      typeof stamps[0]!.animate === "function"
    ) {
      stamps.forEach((el, i) =>
        el.animate(
          [
            { transform: "rotate(-24deg) scale(2.6)", opacity: 0 },
            { transform: "rotate(-4deg) scale(0.9)", opacity: 1, offset: 0.6 },
            { transform: "rotate(-6deg) scale(1)" },
          ],
          {
            duration: 300,
            delay: STAMP_DELAY_MS + i * 220,
            easing: "cubic-bezier(.5,0,.8,.4)",
            fill: "backwards",
          },
        ),
      );
    }
    if (stamps.length && soundOn) c?.sfx("stamp");
    const next: Seen = { ...read(storage) };
    for (const b of list) next[b.key] = b.value;
    try {
      window.localStorage.setItem(storage, JSON.stringify(next));
    } catch {
      /* storage full or blocked: the record may stamp again next time */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  if (!list.length) return null;
  return (
    <ul
      ref={ref}
      aria-label="Records"
      className="m-0 flex list-none flex-wrap gap-3 p-0"
    >
      {list.map((b) => (
        <li
          key={b.key}
          data-kpistamp={b.key}
          // Hidden until its stamp lands; a record that is not new is simply shown.
          style={
            fresh.has(b.key) && !settled && !prefersReducedMotion()
              ? { opacity: 0 }
              : undefined
          }
          className="oct bg-clay inline-flex rotate-[-6deg] flex-col px-4 py-2 font-serif font-semibold text-white"
        >
          <span className="text-[12px]">{b.label}</span>
          <span className="text-[15px]">{b.detail}</span>
        </li>
      ))}
    </ul>
  );
}
