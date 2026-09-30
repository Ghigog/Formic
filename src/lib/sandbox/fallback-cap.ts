import type { UserRecord } from "@/lib/db/repository";

/**
 * The per-person monthly cap on the operator's fallback E2B key. A person on
 * their own key is never capped: only the operator pays for the fallback.
 */

export const FALLBACK_CAP_MESSAGE =
  "You've used your share of the shared sandbox minutes this month. Add your own E2B key in Settings to keep running.";

/** "YYYY-MM" in UTC. The cap starts over when this changes. */
export function capMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

type Usage = Pick<UserRecord, "fallbackSandboxSeconds" | "fallbackSandboxMonth">;

export function fallbackSecondsLeft(
  user: Usage,
  capMinutes: number,
  now: Date = new Date(),
): number {
  const used = user.fallbackSandboxMonth === capMonth(now) ? user.fallbackSandboxSeconds : 0;
  return Math.max(0, capMinutes * 60 - used);
}
