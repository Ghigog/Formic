import type { BoardCard } from "@/lib/domain/entities";
import { type DagNode, topologicalOrder } from "@/lib/domain/dag";

/**
 * What a Queen queues next. Pure: the board service acts on the answer.
 *
 * The work is the target ticket, or an Epic's tickets, plus everything they
 * depend on. It returns the ids of the tickets in that work that are not
 * started and whose own dependencies are all merged, in dependency order.
 *
 * Nothing is returned while any of the work is blocked or failed: the Queen
 * does not retry, it waits for a person.
 */
export function planQueen(cards: readonly BoardCard[], target: BoardCard): string[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const roots =
    target.kind === "epic" ? cards.filter((c) => c.kind === "ticket" && c.epicId === target.id) : [target];

  const work = new Map<string, BoardCard>();
  const pending = [...roots];
  while (pending.length > 0) {
    const card = pending.pop()!;
    if (work.has(card.id)) continue;
    work.set(card.id, card);
    for (const id of card.dependsOn) {
      const dep = byId.get(id);
      if (dep) pending.push(dep);
    }
  }

  const open = [...work.values()].filter((c) => c.status !== "merged");
  if (open.some((c) => c.status === "blocked" || c.status === "failed")) return [];

  const nodes: DagNode[] = open.map((c) => ({
    key: c.id,
    dependsOn: c.dependsOn.filter((id) => work.has(id)),
    fileScope: c.fileScope,
  }));
  return topologicalOrder(nodes).filter((id) => {
    const card = work.get(id)!;
    const unstarted = (card.status === "ready" || card.status === "waiting") && !card.prNumber;
    return unstarted && card.dependsOn.every((dep) => byId.get(dep)?.status === "merged");
  });
}
