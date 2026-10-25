import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { ownerScope } from "@/lib/auth/user";
import { boardsFor, canSeeBoard } from "@/lib/board/sharing";
import { XP_PER_LEVEL, levelOf, scoreOf } from "@/lib/colony/game";
import { COLUMNS, columnOf, type ColumnId } from "@/lib/domain/status";

/** What a read tool answers: the data, or that the board or card is not there for this person. */
export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string };

const notFound = (what: string): ToolResult<never> => ({ ok: false, error: `${what} not found` });

/** A board by id, only if this person can see it. */
async function visibleBoard(user: UserRecord, boardId: string): Promise<ProjectSummary | null> {
  const project = await repository().projectById(boardId);
  return project && (await canSeeBoard(user, project)) ? project : null;
}

export async function listBoards(user: UserRecord) {
  const boards = await boardsFor(user, await repository().listProjects(ownerScope(user)));
  return boards.map((b) => ({ id: b.id, name: b.name, repo: b.repoFullName }));
}

export async function listCards(user: UserRecord, input: { board: string; column?: ColumnId }) {
  const project = await visibleBoard(user, input.board);
  if (!project) return notFound("Board");
  const cards = (await repository().boardCards(project.id))
    .map((c) => ({ card: c, column: columnOf(c) }))
    .filter((c) => !input.column || c.column === input.column);
  return {
    ok: true as const,
    value: cards.map(({ card, column }) => ({
      id: card.id,
      key: card.key,
      kind: card.kind,
      title: card.title,
      status: card.status,
      column,
      epicId: card.epicId,
    })),
  };
}

/** An Epic with its PRD, or a ticket with its description and acceptance criteria. */
export async function getCard(user: UserRecord, input: { board: string; card: string }) {
  const project = await visibleBoard(user, input.board);
  if (!project) return notFound("Card");
  const repo = repository();
  const card = await repo.cardById(input.card);
  if (!card) return notFound("Card");
  if (card.kind === "epic") {
    const epic = await repo.epicDetail(card.id);
    if (!epic || !(await ownedBy(project, card.id))) return notFound("Card");
    return {
      ok: true as const,
      value: { id: card.id, kind: "epic", key: card.key, title: epic.title, status: card.status, rawRequest: epic.rawRequest, prd: epic.prd },
    };
  }
  const ticket = await repo.ticketDetail(card.id);
  if (!ticket || ticket.projectId !== project.id) return notFound("Card");
  return {
    ok: true as const,
    value: {
      id: ticket.id,
      kind: "ticket",
      key: ticket.key,
      title: ticket.title,
      status: ticket.status,
      column: columnOf(ticket),
      epicId: ticket.epicId,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      fileScope: ticket.fileScope,
      storyPoints: ticket.storyPoints,
      prNumber: ticket.prNumber,
      prUrl: ticket.prUrl,
    },
  };
}

/** Whether an Epic is one of the board's cards. */
async function ownedBy(project: ProjectSummary, epicId: string): Promise<boolean> {
  return (await repository().boardCards(project.id)).some((c) => c.id === epicId);
}

export async function getColony(user: UserRecord, input: { board: string }) {
  const project = await visibleBoard(user, input.board);
  if (!project) return notFound("Board");
  const { earned } = scoreOf(await repository().boardCards(project.id));
  return {
    ok: true as const,
    value: { level: levelOf(earned), xp: earned, xpIntoLevel: earned % XP_PER_LEVEL, xpPerLevel: XP_PER_LEVEL },
  };
}

export { COLUMNS };
