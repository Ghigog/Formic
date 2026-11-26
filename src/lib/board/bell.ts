import "server-only";

import { repository } from "@/lib/db";
import { limitStoppedCards, ringBell } from "@/lib/colony/bell";

/**
 * The golden bell: armed, it rings the silver bell's ring for the person, one
 * minute after the agent's limit resets, so a person away from the board
 * comes back to work done. It restarts at most BELL_BATCH cards every
 * BELL_GAP_MS across all of one person's boards, and one bell is spent when
 * the last of its board's cards is out.
 */

/** The wait after a reset, so the provider's window has surely reopened. */
export const BELL_DELAY_MS = 60_000;

/**
 * The golden bell restarts a few cards at a time, this far apart, counted
 * across every board one person owns (they share one Claude account): every
 * stopped card starting the minute a limit resets spent the fresh window at once.
 */
export const BELL_BATCH = 5;
export const BELL_GAP_MS = 10 * 60_000;

declare global {
  var __formicBellRung: Map<string, { at: number; sent: number }> | undefined;
}
/** Per account (the board owner): when its current batch started and how many it restarted. */
function rung(): Map<string, { at: number; sent: number }> {
  return (globalThis.__formicBellRung ??= new Map());
}

/** Forgets the batches, for tests. */
export function resetBellBatches(): void {
  rung().clear();
}

/** How often the server looks for a golden bell that is due. */
const TICK_MS = 60_000;

/**
 * When the bell is due: each reset of the project's agents, plus a minute.
 * An agent with no mark is due now: its mark was lifted early, because the
 * account was seen working (clearKeyLimited), and the cards it stopped wait
 * for nothing.
 */
async function ringTimes(projectId: string, now: number): Promise<number[]> {
  const repo = repository();
  const project = await repo.projectById(projectId);
  if (!project) return [];
  const ids = new Set(Object.values(await repo.columnAgents(projectId)));
  const presets = await repo.listPresets({ ownerId: project.ownerId ?? "", includeUnowned: project.ownerId === null });
  return presets
    .filter((p) => ids.has(p.id))
    .map((p) => (p.limitedUntil ? Date.parse(p.limitedUntil) + BELL_DELAY_MS : now));
}

/**
 * Rings the bell when it is armed, a card is stopped by a limit and that
 * limit's reset passed a minute ago. The claim is atomic: of several
 * instances finding the same bell due, one rings it.
 */
export async function ringBellIfDue(projectId: string, now = Date.now()): Promise<boolean> {
  const repo = repository();
  if (!(await repo.goldenBell(projectId)).armed) return false;
  if (!(await ringTimes(projectId, now)).some((t) => t <= now)) return false;
  if ((await limitStoppedCards(projectId)).length === 0) return false;
  const account = (await repo.projectById(projectId))?.ownerId ?? projectId;
  const batch = rung().get(account);
  const current = batch && now - batch.at < BELL_GAP_MS ? batch : { at: now, sent: 0 };
  const room = BELL_BATCH - current.sent;
  if (room <= 0) return false;
  const { sent, skipped, left } = await ringBell(projectId, room);
  rung().set(account, { at: current.at, sent: current.sent + sent });
  // The bell is spent once its last card is out.
  if (left === 0) await repo.useGoldenBell(projectId);
  console.info(`[formic] golden bell rang on ${projectId}: ${sent} resumed, ${skipped} still limited, ${left} for later`);
  return true;
}

/** Looks at every armed bell once. Returns how many rang. */
export async function ringDueBells(now = Date.now()): Promise<number> {
  let rang = 0;
  for (const projectId of await repository().armedGoldenBells()) {
    try {
      if (await ringBellIfDue(projectId, now)) rang++;
    } catch (e) {
      console.error("[formic] golden bell failed:", e);
    }
  }
  return rang;
}

let clock: ReturnType<typeof setInterval> | null = null;

/**
 * Nothing else on the server ticks while nobody looks at a board, and a limit
 * usually stops cards when nobody does. So the bell keeps its own clock,
 * started once per server process (src/instrumentation.ts). It reads the
 * armed bells from the database each tick, so a restart loses nothing.
 */
export function startBellClock(): void {
  if (clock) return;
  clock = setInterval(() => {
    ringDueBells().catch((e: unknown) => console.warn("[formic] golden bells skipped:", e));
  }, TICK_MS);
  clock.unref?.();
}
