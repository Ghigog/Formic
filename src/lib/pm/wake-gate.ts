import "server-only";

import { repository } from "@/lib/db";
import type { PmWakeKind } from "@/lib/db/repository";
import { fixAttempts, wakeLimits, type PmWakeLimits } from "@/lib/domain/pm-wake";

export { PM_WAKE_DEFAULTS, PM_WAKE_RANGE, fixAttempts, wakeLimits, type PmWakeLimits } from "@/lib/domain/pm-wake";

/**
 * What bounds the PM waking itself (docs/plans/pm-chat.md, safety rows 3
 * and 5). A ticket that stops or asks a question wakes the PM; these limits
 * keep that from running away with the person's Claude usage:
 *
 * - **Fix cap:** at most `fixCap` looks at one stuck ticket while its branch
 *   stays where the PM left it. A commit the PM lands there does not count as
 *   a change; one from an agent or a person does, and starts the count again.
 * - **Hourly:** at most `perHour` wake-ups in any hour, every ticket together.
 * - **Daily:** at most `perDay` wake-ups a day (UTC), the PM's own allowance,
 *   apart from the coders'.
 *
 * Each limit is said once (per ticket and head, per hour, per day), and the
 * stop is then left for the person as before. Only wake-ups count: a message
 * the person types is never held.
 */

const HOUR_MS = 60 * 60 * 1000;
const WAKES: ReadonlySet<PmWakeKind> = new Set(["question", "stall"]);

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type WakeHeld = "fix-cap" | "hourly" | "daily";

export type WakeVerdict =
  | { ok: true }
  /** `say` is the one line for the chat, or null when it was already said. */
  | { ok: false; held: WakeHeld; say: string | null };

function heldLine(held: WakeHeld, limits: PmWakeLimits, key: string): string {
  switch (held) {
    case "fix-cap":
      return `The PM has looked into ${key} ${limits.fixCap === 1 ? "once" : `${limits.fixCap} times`} since its branch last changed and it is still stuck, so it leaves ${key} to you.`;
    case "hourly":
      return `The PM has woken itself ${limits.perHour} times in the last hour, so it is pausing for a while. Until then, stuck tickets come straight to you.`;
    case "daily":
      return `The PM has used today's ${limits.perDay} wake-ups, so stuck tickets come straight to you until midnight UTC. It still answers anything you ask here. The limit is in the board's settings.`;
  }
}

/**
 * Whether the PM may wake for `cardId` now. When it may, the wake-up is
 * counted. When it may not, the limit is recorded as said, so the next
 * refusal for the same reason says nothing.
 */
export async function admitWake(input: {
  projectId: string;
  cardId: string;
  cardKey: string;
  /** The ticket branch's head, or "" when it has none. */
  head: string;
  kind: "question" | "stall";
  now: Date;
}): Promise<WakeVerdict> {
  const { projectId, cardId, head, kind, now } = input;
  const repo = repository();
  const limits = wakeLimits(await repo.pmWakeLimits(projectId));
  const day = startOfUtcDay(now);
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const recent = await repo.pmWakes(projectId, { since: day < hourAgo ? day : hourAgo });

  const hold = async (held: WakeHeld, since: Date | null): Promise<WakeVerdict> => {
    const said = since
      ? recent.some((r) => r.kind === held && r.createdAt >= since)
      : (await repo.pmWakes(projectId, { cardId })).some((r) => r.kind === held && r.head === head);
    if (!said) await repo.addPmWake({ projectId, cardId: since ? "" : cardId, head: since ? "" : head, kind: held, createdAt: now });
    return { ok: false, held, say: said ? null : heldLine(held, limits, input.cardKey) };
  };

  if (kind === "stall") {
    const attempts = fixAttempts(await repo.pmWakes(projectId, { cardId }), head);
    if (attempts >= limits.fixCap) return hold("fix-cap", null);
  }
  const wakes = recent.filter((r) => WAKES.has(r.kind));
  if (wakes.filter((r) => r.createdAt >= day).length >= limits.perDay) return hold("daily", day);
  if (wakes.filter((r) => r.createdAt >= hourAgo).length >= limits.perHour) return hold("hourly", hourAgo);

  await repo.addPmWake({ projectId, cardId, head, kind, createdAt: now });
  return { ok: true };
}

/** Notes a commit the PM landed on a ticket's branch: the fix cap keeps counting across it. */
export async function noteLanded(projectId: string, cardId: string, sha: string, now: Date): Promise<void> {
  await repository().addPmWake({ projectId, cardId, head: sha, kind: "landed", createdAt: now });
}
