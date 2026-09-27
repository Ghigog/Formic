"use client";

import { useEffect, useState } from "react";

/**
 * Milliseconds left until `until`, ticking each second. Null when there is
 * no deadline or it has passed, so a caller's "unavailable" state ends on
 * its own without a refetch.
 */
export function useCountdown(until: string | null | undefined): number | null {
  const target = until ? Date.parse(until) : NaN;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (Number.isNaN(target) || target <= Date.now()) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= target) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [target]);

  if (Number.isNaN(target)) return null;
  const left = target - now;
  return left > 0 ? left : null;
}

/** "2:48:05", or "48:05" under an hour, or "1d 3:00:00" past a day. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = h > 0 || days > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/**
 * Milliseconds since `since`, ticking each second: how long an agent has
 * been at a card. Null when nothing is working on it.
 */
export function useElapsed(since: string | null | undefined): number | null {
  const start = since ? Date.parse(since) : NaN;
  // Null until mounted: the server's clock and the browser's differ, and a
  // time read during render on both would not hydrate.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (Number.isNaN(start)) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [start]);

  if (Number.isNaN(start) || now === null) return null;
  return Math.max(0, now - start);
}
