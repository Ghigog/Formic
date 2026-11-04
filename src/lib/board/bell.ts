import "server-only";

import { repository } from "@/lib/db";
import { limitStoppedCards, ringBell } from "@/lib/colony/bell";

/**
 * The golden bell: armed, it rings the silver bell's ring for the person, one
 * minute after the agent's limit resets, so a person away from the board
 * comes back to work done. One bell is spent per ring.
 */

/** The wait after a reset, so the provider's window has surely reopened. */
export const BELL_DELAY_MS = 60_000;

/** How often the server looks for a golden bell that is due. */
const TICK_MS = 60_000;

/** When the bell is due: each reset of the project's agents, plus a minute. */
async function ringTimes(projectId: string): Promise<number[]> {
  const repo = repository();
  const project = await repo.projectById(projectId);
  if (!project) return [];
  const ids = new Set(Object.values(await repo.columnAgents(projectId)));
  const presets = await repo.listPresets({ ownerId: project.ownerId ?? "", includeUnowned: project.ownerId === null });
  return presets
    .filter((p) => ids.has(p.id) && p.limitedUntil)
    .map((p) => Date.parse(p.limitedUntil!) + BELL_DELAY_MS);
}

/**
 * Rings the bell when it is armed, a card is stopped by a limit and that
 * limit's reset passed a minute ago. The claim is atomic: of several
 * instances finding the same bell due, one rings it.
 */
export async function ringBellIfDue(projectId: string, now = Date.now()): Promise<boolean> {
  const repo = repository();
  if (!(await repo.goldenBell(projectId)).armed) return false;
  if (!(await ringTimes(projectId)).some((t) => t <= now)) return false;
  if ((await limitStoppedCards(projectId)).length === 0) return false;
  if (!(await repo.useGoldenBell(projectId))) return false;
  const { sent, skipped } = await ringBell(projectId);
  console.info(`[formic] golden bell rang on ${projectId}: ${sent} resumed, ${skipped} still limited`);
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
