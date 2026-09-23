import "server-only";

import { repository } from "@/lib/db";
import type { BoardCard } from "@/lib/domain/entities";
import {
  type ColumnId,
  COLUMN_LABELS,
  canUserMove,
  columnFor,
  columnOf,
  isStalled,
  statusForUserDrop,
} from "@/lib/domain/status";
import type { CardTransition, TransitionResult } from "@/lib/domain/transitions";
import { positionForIndex } from "@/lib/ordering";
import { publish } from "@/lib/events/bus";
import { decomposeEpic, launch, runProductAgent } from "@/lib/agents/pipeline";
import { runCoderAgent } from "@/lib/coder/pipeline";
import { columnLimit } from "@/lib/agents/presets";
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

/**
 * Why a card cannot work in the column it was dropped in, and how to fix it,
 * or null when it can. Written for the person who dropped it: each one says
 * what to do next, because the card stays where they put it.
 */
async function whatIsWrong(
  projectId: string,
  card: BoardCard,
  cards: BoardCard[],
  home: ColumnId,
  to: ColumnId,
): Promise<string | null> {
  const back = `Drag it back to ${COLUMN_LABELS[home]} to undo this.`;

  if (card.kind === "epic" && (to === "in_progress" || to === "in_review" || to === "done")) {
    return card.childCount > 0
      ? `An Epic is not worked on itself; its tickets are. Drag it back to ${COLUMN_LABELS[home]} and move its tickets on from there.`
      : `An Epic is not worked on itself; its tickets are, and it has none yet. Drag it to To Do and the Architect Agent will make them.`;
  }

  if (to === "done") {
    return card.prNumber
      ? `${card.key} reaches Done when its pull request merges. Merge it on GitHub and the card follows. ${back}`
      : `${card.key} reaches Done when its pull request merges, and it has none yet. ${back}`;
  }

  if (to === "in_review" && !card.prNumber) {
    return `${card.key} has no pull request to review yet. Drag it to In Progress from To Do and its agent will open one. ${back}`;
  }

  const verdict = canUserMove(home, to);
  if (!verdict.ok) {
    return `${verdict.reason} Cards move one column at a time so each agent gets its turn. ${back}`;
  }

  const limited = await columnLimit(projectId, to);
  if (limited) return `${limited} ${back}`;

  if (to === "in_progress" && !dependenciesMet(card, cards)) {
    const blocking = card.dependsOn
      .map((id) => cards.find((c) => c.id === id))
      .filter((c) => c && c.status !== "merged")
      .map((c) => c!.key)
      .join(", ");
    return `${card.key} is waiting on ${blocking || "a dependency"} to merge first. Drag it back to To Do; it is ready to go once that merges.`;
  }

  if (to === "in_progress") {
    const conflict = scopeConflict(card, cards);
    if (conflict) {
      return `${conflict.key} is already working in ${conflict.fileScope.join(", ")}, and two agents cannot write the same files at once. Drag this back to To Do and try again when ${conflict.key} is done.`;
    }
  }

  return null;
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

  const shown = columnOf(card);
  // Where it really is: a misplaced card's status never changed.
  const home = columnFor(card.status, card.stalledIn);

  // Trust the server's own view of where the card is, not the client's, so a
  // stale tab cannot move a card an agent already advanced.
  if (shown !== t.from) {
    return {
      ok: false,
      reason: "This card moved while you were dragging it.",
      revertTo: shown,
    };
  }

  const detached = card.kind === "ticket" ? (t.detached ?? false) : undefined;

  // A reorder within a column changes where the card sits and nothing else:
  // status, stall, misplacement and agents all stay as they are. Without
  // this, nudging an epic within To Do re-ran its Architect Agent, and
  // nudging a specified backlog epic reset it to draft. The same holds for a
  // misplaced card going back where it belongs: it simply stops being
  // misplaced.
  if (t.to === shown || t.to === home) {
    const position = await placeAmong(projectId, t.to, card, t.position);
    const misplaced =
      t.to === shown && card.misplacedIn && card.misplacedReason
        ? { in: card.misplacedIn, reason: card.misplacedReason }
        : null;
    await repo.move({
      cardId: card.id,
      kind: card.kind,
      status: card.status,
      stalledIn: card.stalledIn,
      position,
      detached,
      misplaced,
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
    return { ok: true, status: card.status, runId: null, problem: misplaced?.reason ?? null };
  }

  // Somewhere it cannot work: it lands there anyway, as the person asked,
  // keeping its real status and saying what is wrong until it moves again.
  const problem = await whatIsWrong(projectId, card, cards, home, t.to);
  if (problem) {
    const position = await placeAmong(projectId, t.to, card, t.position);
    await repo.move({
      cardId: card.id,
      kind: card.kind,
      status: card.status,
      stalledIn: card.stalledIn,
      position,
      detached,
      misplaced: { in: t.to, reason: problem },
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
    return { ok: true, status: card.status, runId: null, problem };
  }

  // An Epic is broken down from its PRD. With none yet it waits in To Do for
  // one: the Product Agent already writing it, or, when none is (it stalled,
  // or the Epic was somewhere else meanwhile), one started now. Either way
  // the Architect Agent follows once the PRD lands.
  const met = dependenciesMet(card, cards);
  const toArchitect = card.kind === "epic" && t.to === "todo";
  const hasPrd = toArchitect
    ? prdSchema.safeParse((await repo.epicDetail(card.id))?.prd).success
    : false;
  const needsPrd = toArchitect && !hasPrd && card.status !== "draft";

  const status = toArchitect && !hasPrd ? "waiting" : statusForUserDrop(t.to, met);
  const position = await placeAmong(projectId, t.to, card, t.position);

  await repo.move({
    cardId: card.id,
    kind: card.kind,
    status,
    stalledIn: null,
    position,
    detached,
  });
  await repo.rebalanceColumn(projectId, t.to);

  await publish(projectId, {
    type: "card.status",
    cardId: card.id,
    kind: card.kind,
    status,
    stalledIn: null,
    stage: needsPrd ? 1 : card.stage,
    blockedReason: null,
  });

  // Moving an Epic into To Do is the Architect Agent's trigger. It runs
  // detached so the drag returns immediately; progress arrives over SSE.
  if (toArchitect && hasPrd) {
    launch(
      () => decomposeEpic(projectId, card.id),
      `architect agent for ${card.key}`,
    );
  }
  if (needsPrd) {
    const detail = await repo.epicDetail(card.id);
    await repo.setEpicRunnerJob(card.id, null);
    launch(
      () => runProductAgent(projectId, card.id, detail?.rawRequest ?? card.title),
      `product agent for ${card.key}`,
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

/**
 * How long a planning agent may go quiet before its Epic counts as stuck.
 * An API agent finishes well inside a function's lifetime; a CLI agent has
 * a runner job, and is waited on for as long as that runs.
 */
const QUIET_MS = 15 * 60_000;

/**
 * Whether an Epic's planning stopped and needs a person to start it again:
 * it stalled, or it never got its PRD and nothing is still writing one.
 */
export function canRetryEpic(
  card: BoardCard,
  detail: { prd: unknown; runnerJob: string | null },
  now = Date.now(),
): boolean {
  if (card.kind !== "epic") return false;
  if (isStalled(card.status)) return true;
  if (prdSchema.safeParse(detail.prd).success || detail.runnerJob) return false;
  if (card.status !== "draft" && card.status !== "waiting") return false;
  const since = Date.parse(card.updatedAt ?? card.createdAt ?? "");
  return Number.isFinite(since) && now - since > QUIET_MS;
}

export type EpicActionResult = { ok: true } | { ok: false; reason: string; status: number };

/**
 * Starts a stalled Epic's planning again from where it stopped: the Product
 * Agent when it has no PRD, the Architect Agent when it has one and sits in
 * To Do. Either way the card leaves its stall and shows it is working.
 */
export async function retryEpic(projectId: string, epicId: string): Promise<EpicActionResult> {
  const repo = repository();
  const card = await repo.cardById(epicId);
  const detail = await repo.epicDetail(epicId);
  if (!card || card.kind !== "epic" || !detail) {
    return { ok: false, reason: "That Epic no longer exists.", status: 404 };
  }
  if (!canRetryEpic(card, detail)) {
    return { ok: false, reason: `${card.key} is still being worked on.`, status: 409 };
  }

  const column = columnFor(card.status, card.stalledIn);
  const hasPrd = prdSchema.safeParse(detail.prd).success;
  const inTodo = column === "todo";
  // With no PRD, a To Do Epic waits for it and is then broken down; one in
  // Backlog just gets its PRD.
  const status = hasPrd ? (inTodo ? "ready" : "specified") : inTodo ? "waiting" : "draft";
  const stage = hasPrd ? 2 : 1;

  await repo.setEpicRunnerJob(epicId, null);
  await repo.move({ cardId: epicId, kind: "epic", status, stalledIn: null, position: card.position });
  await publish(projectId, {
    type: "card.status",
    cardId: epicId,
    kind: "epic",
    status,
    stalledIn: null,
    stage,
    blockedReason: null,
  });

  if (!hasPrd) {
    launch(
      () => runProductAgent(projectId, epicId, detail.rawRequest),
      `product agent for ${card.key}`,
    );
  } else if (inTodo) {
    launch(() => decomposeEpic(projectId, epicId), `architect agent for ${card.key}`);
  }
  return { ok: true };
}

/**
 * Removes an Epic someone no longer wants, with its PRD and every ticket
 * under it. Refused while one of its tickets has an agent writing code: that
 * run would push to a branch nothing is tracking. Its GitHub issues close as
 * not planned.
 */
export async function deleteEpic(projectId: string, epicId: string): Promise<EpicActionResult> {
  const repo = repository();
  const card = await repo.cardById(epicId);
  const detail = await repo.epicDetail(epicId);
  if (!card || card.kind !== "epic" || !detail) {
    return { ok: false, reason: "That Epic no longer exists.", status: 404 };
  }

  const tickets = await repo.ticketsForEpic(epicId);
  const running = tickets.filter((t) => t.status === "running");
  if (running.length > 0) {
    return {
      ok: false,
      reason: `${running.map((t) => t.key).join(", ")} ${running.length === 1 ? "is" : "are"} still running. Stop ${running.length === 1 ? "it" : "them"} first.`,
      status: 409,
    };
  }

  const issueNumbers = [detail.issueNumber, ...tickets.map((t) => t.issueNumber)].filter(
    (n): n is number => n !== null,
  );
  await repo.deleteEpic(epicId);
  await publish(projectId, { type: "card.deleted", cardId: epicId, kind: "epic", issueNumbers });
  return { ok: true };
}
