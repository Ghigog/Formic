import "server-only";

import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { runningConflict } from "@/lib/domain/queue";
import { byPosition } from "@/lib/ordering";

declare global {
  var __formicQueueTurns: Map<string, Promise<void>> | undefined;
}

/**
 * Starts every queued ticket whose files no running ticket is writing any
 * more, in the order they sit in In Progress, so a person orders the queue
 * by ordering the column. Each one started counts against the ones after it.
 *
 * One pass at a time per project: two status changes landing together would
 * otherwise both see the same ticket free and start it twice.
 */
export function startQueued(projectId: string): Promise<void> {
  const turns = (globalThis.__formicQueueTurns ??= new Map());
  const turn = (turns.get(projectId) ?? Promise.resolve()).then(() => pass(projectId));
  const settled = turn.catch((e: unknown) => console.error("[formic] starting queued tickets failed:", e));
  turns.set(projectId, settled);
  void settled.then(() => {
    if (turns.get(projectId) === settled) turns.delete(projectId);
  });
  return settled;
}

async function pass(projectId: string): Promise<void> {
  const repo = repository();
  const cards = await repo.boardCards(projectId);
  const queued = cards.filter((c) => c.kind === "ticket" && c.status === "queued").sort(byPosition);
  if (queued.length === 0) return;

  const { runCoderAgent } = await import("@/lib/coder/pipeline");
  const { launch } = await import("@/lib/agents/pipeline");

  for (const card of queued) {
    if (runningConflict(card, cards)) continue;
    await repo.updateTicket(card.id, { status: "running", attempts: 0 });
    card.status = "running";
    await publish(projectId, {
      type: "card.status",
      cardId: card.id,
      kind: "ticket",
      status: "running",
      stalledIn: null,
      stage: card.stage,
      blockedReason: null,
    });
    launch(() => runCoderAgent(projectId, card.id), `coder agent for ${card.key}`);
  }
}
