import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { ownerScope } from "@/lib/auth/user";
import { startedBy, withActor } from "@/lib/auth/actor";
import { boardsFor, canSeeBoard } from "@/lib/board/sharing";
import { XP_PER_LEVEL, levelOf, scoreOf } from "@/lib/colony/game";
import { COLUMNS, columnOf, type ColumnId } from "@/lib/domain/status";
import { applyTransition, createBacklogItem } from "@/lib/board/service";
import { applyPrd } from "@/lib/agents/pipeline";
import { publish } from "@/lib/events/bus";
import { positionForIndex } from "@/lib/ordering";
import type { Prd } from "@/lib/domain/entities";
import type { TicketUpdate } from "@/lib/db/repository";

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

/** Who is calling a write tool: the person, and whether their token may change anything. */
export interface Caller {
  user: UserRecord;
  readOnly: boolean;
}

const READ_ONLY = "This token is read-only; it cannot change the board.";

/** Runs a write on a board the caller can see, refusing a read-only token before anything else is looked at. */
async function writeOn<T>(
  caller: Caller,
  boardId: string,
  write: (project: ProjectSummary) => Promise<ToolResult<T>>,
): Promise<ToolResult<T>> {
  if (caller.readOnly) return { ok: false, error: READ_ONLY };
  const project = await visibleBoard(caller.user, boardId);
  if (!project) return notFound("Board");
  return withActor(caller.user.id, () => write(project));
}

/** The card, if it is one of this board's. */
async function boardCard(projectId: string, cardId: string) {
  return (await repository().boardCards(projectId)).find((c) => c.id === cardId) ?? null;
}

export function createBacklogCard(caller: Caller, input: { board: string; rawRequest: string }) {
  return writeOn(caller, input.board, async (project) => {
    const card = await createBacklogItem(project.id, input.rawRequest);
    return { ok: true as const, value: { id: card.id, key: card.key, title: card.title } };
  });
}

export interface EpicTicketInput {
  /** A handle for dependsOn within this call. */
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope?: string[];
  storyPoints?: number | null;
  dependsOn?: string[];
}

/** An Epic with its tickets, already broken down: no agent plans it. */
export function createEpic(caller: Caller, input: { board: string; title: string; rawRequest: string; tickets: EpicTicketInput[] }) {
  return writeOn(caller, input.board, async (project) => {
    const handles = new Set(input.tickets.map((t) => t.key));
    for (const t of input.tickets) {
      const missing = (t.dependsOn ?? []).find((d) => !handles.has(d));
      if (missing) return { ok: false as const, error: `${t.key} depends on ${missing}, which is not one of the tickets.` };
    }
    const repo = repository();
    const backlog = await repo.columnPositions(project.id, "backlog");
    const epic = await repo.createEpic({
      projectId: project.id,
      title: input.title,
      rawRequest: input.rawRequest,
      position: positionForIndex(backlog, backlog.length),
    });
    await startedBy(epic.id);
    const keyFor = new Map(input.tickets.map((t, i) => [t.key, `${epic.key}-T${i + 1}`]));
    const todo = await repo.columnPositions(project.id, "todo");
    const made = await repo.createTickets(
      input.tickets.map((t, i) => ({
        epicId: epic.id,
        key: keyFor.get(t.key)!,
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        fileScope: t.fileScope ?? [],
        storyPoints: t.storyPoints ?? null,
        position: positionForIndex(todo, todo.length + i),
        dependsOnKeys: (t.dependsOn ?? []).map((d) => keyFor.get(d)!),
      })),
    );
    await publish(project.id, { type: "card.created", cardId: epic.id, kind: "epic", epicId: epic.id });
    return { ok: true as const, value: { id: epic.id, key: epic.key, tickets: made.map((c) => ({ id: c.id, key: c.key })) } };
  });
}

export function moveCard(caller: Caller, input: { board: string; card: string; to: ColumnId }) {
  return writeOn(caller, input.board, async (project) => {
    const card = await boardCard(project.id, input.card);
    if (!card) return notFound("Card");
    const positions = await repository().columnPositions(project.id, input.to);
    const result = await applyTransition(project.id, {
      cardId: card.id,
      kind: card.kind,
      from: columnOf(card),
      to: input.to,
      position: positionForIndex(positions, positions.length),
      actor: "user",
    });
    return result.ok
      ? { ok: true as const, value: { status: result.status, runId: result.runId, problem: result.problem ?? null } }
      : { ok: false as const, error: result.reason };
  });
}

export interface CardEdit {
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  fileScope?: string[];
  storyPoints?: number | null;
  /** An Epic's PRD, as the UI edits it. */
  prd?: Prd;
}

export function updateCard(caller: Caller, input: { board: string; card: string; edit: CardEdit }) {
  return writeOn(caller, input.board, async (project) => {
    const card = await boardCard(project.id, input.card);
    if (!card) return notFound("Card");
    const { prd, ...fields } = input.edit;
    if (card.kind === "epic") {
      if (Object.keys(fields).length) return { ok: false as const, error: "An Epic's PRD is the only thing of it you can edit." };
      if (!prd) return { ok: false as const, error: "Nothing to change." };
      await applyPrd(project.id, card.id, prd, true);
      return { ok: true as const, value: { id: card.id } };
    }
    if (prd) return { ok: false as const, error: "Only an Epic has a PRD." };
    const update: TicketUpdate = fields;
    if (!Object.keys(update).length) return { ok: false as const, error: "Nothing to change." };
    await repository().updateTicket(card.id, update);
    await publish(project.id, {
      type: "card.status",
      cardId: card.id,
      kind: "ticket",
      status: card.status,
      stalledIn: card.stalledIn,
      stage: card.stage,
      blockedReason: card.blockedReason,
    });
    return { ok: true as const, value: { id: card.id } };
  });
}

/** A person's message in the card's chat. No agent answers it. */
export function commentCard(caller: Caller, input: { board: string; card: string; text: string }) {
  return writeOn(caller, input.board, async (project) => {
    const card = await boardCard(project.id, input.card);
    if (!card) return notFound("Card");
    const message = await repository().addCardChatMessage({
      projectId: project.id,
      cardKind: card.kind,
      cardId: card.id,
      role: "user",
      content: input.text,
    });
    return { ok: true as const, value: { id: message.id } };
  });
}

export { COLUMNS };
