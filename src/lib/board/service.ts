import "server-only";

import { repository } from "@/lib/db";
import type { BoardCard } from "@/lib/domain/entities";
import {
  type ColumnId,
  canUserMove,
  columnFor,
  statusForUserDrop,
} from "@/lib/domain/status";
import type { CardTransition, TransitionResult } from "@/lib/domain/transitions";
import { positionForIndex } from "@/lib/ordering";
import { publish } from "@/lib/events/bus";

/**
 * Server-side move handling. The board proposes; this decides.
 *
 * Every rejection names a reason the UI can show and a column to snap back to,
 * because a card that silently returns to where it started reads as a bug.
 */

function dependenciesMet(card: BoardCard, all: BoardCard[]): boolean {
  if (card.dependsOn.length === 0) return true;
  const merged = new Set(
    all.filter((c) => c.status === "merged").map((c) => c.id),
  );
  return card.dependsOn.every((id) => merged.has(id));
}

export async function applyTransition(
  projectId: string,
  t: CardTransition,
): Promise<TransitionResult> {
  const repo = repository();
  const cards = await repo.boardCards(projectId);
  const card = cards.find((c) => c.id === t.cardId);

  if (!card) {
    return { ok: false, reason: "That card no longer exists.", revertTo: t.from };
  }

  const actual = columnFor(card.status, card.stalledIn);

  // Trust the server's own view of where the card is, not the client's, so a
  // stale tab cannot move a card an agent already advanced.
  if (actual !== t.from) {
    return {
      ok: false,
      reason: "This card moved while you were dragging it.",
      revertTo: actual,
    };
  }

  const verdict = canUserMove(actual, t.to);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason, revertTo: actual };
  }

  const met = dependenciesMet(card, cards);
  if (t.to === "in_progress" && !met) {
    const blocking = card.dependsOn
      .map((id) => cards.find((c) => c.id === id)?.key)
      .filter(Boolean)
      .join(", ");
    return {
      ok: false,
      reason: `${card.key} is waiting on ${blocking || "a dependency"} to merge first.`,
      revertTo: actual,
    };
  }

  const status = statusForUserDrop(t.to, met);
  const positions = (await repo.columnPositions(projectId, t.to)).filter(
    (p) => p !== card.position,
  );
  const index = positions.findIndex((p) => p > t.position);
  const position = positionForIndex(
    positions,
    index === -1 ? positions.length : index,
  );

  await repo.move({
    cardId: card.id,
    kind: card.kind,
    status,
    stalledIn: null,
    position,
  });
  await repo.rebalanceColumn(projectId, t.to);

  await publish(projectId, {
    type: "card.status",
    cardId: card.id,
    kind: card.kind,
    status,
    stalledIn: null,
    stage: card.stage,
    blockedReason: null,
  });

  return { ok: true, status, runId: null };
}

export async function createBacklogItem(
  projectId: string,
  rawRequest: string,
): Promise<BoardCard> {
  const repo = repository();
  const positions = await repo.columnPositions(projectId, "backlog");
  const position = positionForIndex(positions, positions.length);

  const title =
    rawRequest.trim().split(/[.\n]/)[0]?.slice(0, 80) || "New backlog item";

  const card = await repo.createEpic({
    projectId,
    title,
    rawRequest: rawRequest.trim(),
    position,
  });

  await publish(projectId, {
    type: "card.created",
    cardId: card.id,
    kind: "epic",
    epicId: null,
  });

  return card;
}
