import "server-only";

import { repository } from "@/lib/db";
import { launch } from "@/lib/agents/pipeline";
import { publish } from "@/lib/events/bus";
import { isStalled } from "@/lib/domain/status";

/**
 * The golden bell: armed, it restarts the cards a usage limit stopped, one
 * minute after the agent's limit resets, so a person away from the board
 * comes back to work done. One bell is spent per ring.
 */

/** The wait after a reset, so the provider's window has surely reopened. */
export const BELL_DELAY_MS = 60_000;

/** The reason a runner gives a card its agent's usage limit stopped (see runner.ts). */
const LIMIT_REASON = "Usage limit reached";

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The tickets a usage limit stopped. */
async function limitStopped(projectId: string) {
  return (await repository().boardCards(projectId)).filter(
    (c) => c.kind === "ticket" && isStalled(c.status) && c.blockedReason?.startsWith(LIMIT_REASON),
  );
}

/** When the bell is next due: the soonest reset of the project's agents, plus a minute. */
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

/** Restarts every card the limit stopped. */
export async function ringBell(projectId: string): Promise<void> {
  const { runCoderAgent } = await import("@/lib/coder/pipeline");
  for (const card of await limitStopped(projectId)) {
    await repository().updateTicket(card.id, { status: "running", stalledIn: null, blockedReason: null });
    await publish(projectId, {
      type: "card.status",
      cardId: card.id,
      kind: "ticket",
      status: "running",
      stalledIn: null,
      stage: card.stage,
      blockedReason: null,
    });
    launch(() => runCoderAgent(projectId, card.id), `coder agent for ${card.key}, bell rung`);
  }
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
  if ((await limitStopped(projectId)).length === 0) return false;
  if (!(await repo.useGoldenBell(projectId))) return false;
  await ringBell(projectId);
  return true;
}

/**
 * Nothing on the server ticks by itself: the sweep runs only while a board is
 * looked at. So an armed bell also sets a timer for the next reset, and a
 * closed board still rings. The sweep stays the fallback after a restart.
 */
export async function scheduleBell(projectId: string, now = Date.now()): Promise<void> {
  clearTimeout(timers.get(projectId));
  timers.delete(projectId);
  if (!(await repository().goldenBell(projectId)).armed) return;
  const next = (await ringTimes(projectId)).filter((t) => t > now).sort((a, b) => a - b)[0];
  if (next === undefined) return;
  const timer = setTimeout(() => {
    timers.delete(projectId);
    ringBellIfDue(projectId)
      .catch((e: unknown) => console.error("[formic] golden bell failed:", e))
      .finally(() => scheduleBell(projectId).catch(() => undefined));
  }, next - now);
  timer.unref?.();
  timers.set(projectId, timer);
}
