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
import { launch, runArchitectAgent, runProductAgent } from "@/lib/agents/pipeline";
import { runCoderAgent } from "@/lib/coder/pipeline";
import { prdSchema } from "@/lib/domain/entities";
import { scopesOverlap } from "@/lib/domain/scope";

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

/**
 * The other card already writing these files, if there is one.
 *
 * Only running cards count. A card in review holds an open pull request, but
 * it is not editing a checkout, and treating it as a conflict would stall the
 * board for as long as CI takes — which is most of the time.
 */
function scopeConflict(card: BoardCard, all: BoardCard[]): BoardCard | null {
  if (card.fileScope.length === 0) return null;
  return (
    all.find(
      (other) =>
        other.id !== card.id &&
        other.status === "running" &&
        other.fileScope.length > 0 &&
        scopesOverlap(card.fileScope, other.fileScope),
    ) ?? null
  );
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

  // A reorder within a column changes where the card sits and nothing else:
  // status, stall and agents all stay as they are. Without this, nudging an
  // epic within To Do re-ran its Architect Agent, and nudging a specified
  // backlog epic reset it to draft.
  if (actual === t.to) {
    const position = await placeAmong(projectId, t.to, card, t.position);
    await repo.move({
      cardId: card.id,
      kind: card.kind,
      status: card.status,
      stalledIn: card.stalledIn,
      position,
      detached: card.kind === "ticket" ? (t.detached ?? false) : undefined,
    });
    await repo.rebalanceColumn(projectId, t.to);
    await publish(projectId, {
      type: "card.status",
      cardId: card.id,
      kind: card.kind,
      status: card.status,
      stalledIn: card.stalledIn,
      stage: card.stage,
      blockedReason: card.blockedReason,
    });
    return { ok: true, status: card.status, runId: null };
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

  if (t.to === "in_progress") {
    const conflict = scopeConflict(card, cards);
    if (conflict) {
      return {
        ok: false,
        reason: `${conflict.key} is already working in ${conflict.fileScope.join(", ")}. Two agents cannot write the same files at once.`,
        revertTo: actual,
      };
    }
  }

  const status = statusForUserDrop(t.to, met);
  const position = await placeAmong(projectId, t.to, card, t.position);

  await repo.move({
    cardId: card.id,
    kind: card.kind,
    status,
    stalledIn: null,
    position,
    detached: card.kind === "ticket" ? (t.detached ?? false) : undefined,
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

  // Moving an Epic into To Do is the Architect Agent's trigger. It runs
  // detached so the drag returns immediately; progress arrives over SSE.
  if (card.kind === "epic" && t.to === "todo") {
    const detail = await repo.epicDetail(card.id);
    const prd = prdSchema.safeParse(detail?.prd);

    if (!prd.success) {
      return {
        ok: true,
        status,
        runId: null,
      };
    }

    const tree = await repoTree();
    const title = detail!.title;

    launch(
      () => runArchitectAgent(projectId, card.id, title, prd.data, tree),
      `architect agent for ${card.key}`,
    );
  }

  // Moving a ticket into In Progress is the Coder Agent's trigger: sandbox,
  // implement, check the diff against the file scope, push, open a pull
  // request. Detached for the same reason as above.
  if (card.kind === "ticket" && t.to === "in_progress") {
    launch(
      () => runCoderAgent(projectId, card.id),
      `coder agent for ${card.key}`,
    );
  }

  return { ok: true, status, runId: null };
}

/**
 * The client's proposed position, re-derived against the server's column so
 * a card that moved meanwhile cannot produce a collision: the card lands
 * between the same two neighbours the client saw.
 */
async function placeAmong(
  projectId: string,
  column: ColumnId,
  card: BoardCard,
  proposed: number,
): Promise<number> {
  const positions = (await repository().columnPositions(projectId, column)).filter(
    (p) => p !== card.position,
  );
  const index = positions.findIndex((p) => p > proposed);
  return positionForIndex(positions, index === -1 ? positions.length : index);
}

/**
 * Top-level directories the Architect Agent uses to ground its file scopes.
 * Read from the sandbox once PROT-05 is wired in; until then the known layout
 * of this repository is a better prompt than nothing.
 */
async function repoTree(): Promise<string[]> {
  return [
    "src/app",
    "src/components",
    "src/lib",
    "prisma",
    "docs",
    "scripts",
  ];
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

  // Stage 1 -> 2. The Product Agent expands the raw request into a PRD.
  launch(
    () => runProductAgent(projectId, card.id, rawRequest.trim()),
    `product agent for ${card.key}`,
  );

  return card;
}
