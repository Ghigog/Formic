import "server-only";

import { repository } from "@/lib/db";
import type { BoardCard } from "@/lib/domain/entities";
import { orderEpics, waitLine, type OrderEpic } from "@/lib/domain/epic-order";

function toOrderEpic(epic: BoardCard, cards: readonly BoardCard[]): OrderEpic {
  return {
    id: epic.id,
    key: epic.key,
    tickets: cards
      .filter((c) => c.kind === "ticket" && c.epicId === epic.id && !c.archived)
      .map((c) => ({
        fileScope: c.fileScope,
        storyPoints: c.storyPoints,
        moveOnly: c.moveOnly,
        merged: c.status === "merged",
      })),
  };
}

/**
 * After an Epic's breakdown is applied: make it wait for the in-flight Epics
 * over the same files (or make them wait for it, when it is a restructure),
 * and say so in the waiting Epic's chat.
 */
export async function orderNewEpic(projectId: string, epicId: string): Promise<void> {
  const repo = repository();
  const cards = await repo.boardCards(projectId);
  const created = cards.find((c) => c.id === epicId && c.kind === "epic");
  if (!created) return;
  const others = cards.filter(
    (c) => c.kind === "epic" && c.id !== epicId && !c.archived && c.status !== "merged",
  );
  const waits = orderEpics(
    toOrderEpic(created, cards),
    others.map((o) => toOrderEpic(o, cards)),
  );
  for (const wait of waits) {
    const already = cards.find((c) => c.id === wait.epicId)?.waitsFor?.includes(wait.waitsForId);
    await repo.setEpicWaits(wait.epicId, [wait.waitsForId]);
    if (already) continue;
    await repo.addCardChatMessage({
      projectId,
      cardKind: "epic",
      cardId: wait.epicId,
      role: "assistant",
      content: waitLine(wait),
      status: "done",
    });
  }
}
