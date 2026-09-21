import "server-only";

import { prisma } from "./client";
import type {
  CreateEpicInput,
  CreateTicketInput,
  MoveInput,
  ProjectSummary,
  Repository,
} from "./repository";
import type { BoardCard } from "@/lib/domain/entities";
import { type ColumnId, type TicketStatus, columnFor } from "@/lib/domain/status";
import { byPosition, needsRebalance, rebalance } from "@/lib/ordering";
import { normalizeScope } from "@/lib/domain/scope";

type EpicRow = {
  id: string;
  title: string;
  status: TicketStatus;
  stalledIn: ColumnId | null;
  stage: number;
  position: number;
  createdAt: Date;
  tickets: Array<{ id: string; status: TicketStatus }>;
};

function epicKey(index: number): string {
  return `EPIC-${index + 1}`;
}

export class PrismaRepository implements Repository {
  async defaultProject(): Promise<ProjectSummary> {
    const db = prisma();
    const existing = await db.project.findFirst({ orderBy: { createdAt: "asc" } });
    if (existing) return existing;

    return db.project.create({
      data: {
        name: "Formic",
        repoFullName: process.env.GITHUB_REPO ?? "Ghigog/Formic",
        baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
      },
    });
  }

  async boardCards(projectId: string): Promise<BoardCard[]> {
    const db = prisma();

    const epics = await db.epic.findMany({
      where: { projectId },
      orderBy: { position: "asc" },
      include: { tickets: { select: { id: true, status: true } } },
    });

    const tickets = await db.ticket.findMany({
      where: { epic: { projectId } },
      orderBy: { position: "asc" },
      include: {
        dependsOn: { select: { dependsOnTicketId: true } },
        runs: {
          where: { status: { in: ["queued", "running"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { role: true, model: true },
        },
      },
    });

    const epicCards: BoardCard[] = epics.map((epic: EpicRow, i: number) => ({
      id: epic.id,
      kind: "epic" as const,
      key: epicKey(i),
      title: epic.title,
      status: epic.status,
      stalledIn: epic.stalledIn,
      stage: epic.stage,
      position: epic.position,
      epicId: null,
      size: null,
      agentRole: null,
      model: null,
      fileScope: [],
      dependsOn: [],
      prNumber: null,
      prUrl: null,
      blockedReason: null,
      costCents: 0,
      childCount: epic.tickets.length,
      doneCount: epic.tickets.filter((t) => t.status === "merged").length,
    }));

    const ticketCards: BoardCard[] = tickets.map((t) => ({
      id: t.id,
      kind: "ticket" as const,
      key: t.key,
      title: t.title,
      status: t.status,
      stalledIn: t.stalledIn,
      stage: t.stage,
      position: t.position,
      epicId: t.epicId,
      size: t.size,
      agentRole: t.runs[0]?.role ?? null,
      model: t.runs[0]?.model ?? null,
      fileScope: t.fileScope,
      dependsOn: t.dependsOn.map((d) => d.dependsOnTicketId),
      prNumber: t.prNumber,
      prUrl: t.prUrl,
      blockedReason: t.blockedReason,
      costCents: t.costCents,
      childCount: 0,
      doneCount: 0,
    }));

    return [...epicCards, ...ticketCards].sort(byPosition);
  }

  async createEpic(input: CreateEpicInput): Promise<BoardCard> {
    const db = prisma();
    const epic = await db.epic.create({
      data: {
        projectId: input.projectId,
        title: input.title,
        rawRequest: input.rawRequest,
        position: input.position,
        status: "draft",
        stage: 1,
      },
    });
    const count = await db.epic.count({ where: { projectId: input.projectId } });

    return {
      id: epic.id,
      kind: "epic",
      key: epicKey(count - 1),
      title: epic.title,
      status: epic.status,
      stalledIn: epic.stalledIn,
      stage: epic.stage,
      position: epic.position,
      epicId: null,
      size: null,
      agentRole: null,
      model: null,
      fileScope: [],
      dependsOn: [],
      prNumber: null,
      prUrl: null,
      blockedReason: null,
      costCents: 0,
      childCount: 0,
      doneCount: 0,
    };
  }

  async createTickets(inputs: CreateTicketInput[]): Promise<BoardCard[]> {
    const db = prisma();

    return db.$transaction(async (tx) => {
      const created = [];
      for (const input of inputs) {
        const row = await tx.ticket.create({
          data: {
            epicId: input.epicId,
            key: input.key,
            title: input.title,
            description: input.description,
            acceptanceCriteria: input.acceptanceCriteria,
            fileScope: normalizeScope(input.fileScope),
            size: input.size,
            position: input.position,
            status: input.dependsOnKeys.length === 0 ? "ready" : "waiting",
            stage: 3,
          },
        });
        created.push(row);
      }

      // Dependencies are declared by key and resolved to ids once every
      // sibling exists, so ordering within the batch does not matter.
      const byKey = new Map(created.map((t) => [t.key, t.id]));
      for (const input of inputs) {
        const ticketId = byKey.get(input.key);
        if (!ticketId) continue;
        for (const depKey of input.dependsOnKeys) {
          const dependsOnTicketId = byKey.get(depKey);
          if (!dependsOnTicketId) continue;
          await tx.ticketDependency.create({
            data: { ticketId, dependsOnTicketId },
          });
        }
      }

      return created.map((t) => ({
        id: t.id,
        kind: "ticket" as const,
        key: t.key,
        title: t.title,
        status: t.status,
        stalledIn: t.stalledIn,
        stage: t.stage,
        position: t.position,
        epicId: t.epicId,
        size: t.size,
        agentRole: null,
        model: null,
        fileScope: t.fileScope,
        dependsOn: inputs
          .find((i) => i.key === t.key)
          ?.dependsOnKeys.map((k) => byKey.get(k) ?? k) ?? [],
        prNumber: null,
        prUrl: null,
        blockedReason: null,
        costCents: 0,
        childCount: 0,
        doneCount: 0,
      }));
    });
  }

  async move(input: MoveInput): Promise<void> {
    const db = prisma();
    const data = {
      status: input.status,
      stalledIn: input.stalledIn,
      position: input.position,
    };
    if (input.kind === "epic") {
      await db.epic.update({ where: { id: input.cardId }, data });
    } else {
      await db.ticket.update({ where: { id: input.cardId }, data });
    }
  }

  async columnPositions(projectId: string, column: ColumnId): Promise<number[]> {
    const cards = await this.boardCards(projectId);
    return cards
      .filter((c) => columnFor(c.status, c.stalledIn) === column)
      .map((c) => c.position)
      .sort((a, b) => a - b);
  }

  async cardById(id: string): Promise<BoardCard | null> {
    const db = prisma();
    const epic = await db.epic.findUnique({ where: { id } });
    if (epic) {
      const project = await this.defaultProject();
      const cards = await this.boardCards(project.id);
      return cards.find((c) => c.id === id) ?? null;
    }
    const ticket = await db.ticket.findUnique({
      where: { id },
      include: { epic: { select: { projectId: true } } },
    });
    if (!ticket) return null;
    const cards = await this.boardCards(ticket.epic.projectId);
    return cards.find((c) => c.id === id) ?? null;
  }

  async epicDetail(epicId: string) {
    const db = prisma();
    const epic = await db.epic.findUnique({
      where: { id: epicId },
      select: { title: true, rawRequest: true, prd: true },
    });
    return epic ?? null;
  }

  async setEpicPrd(epicId: string, prd: unknown, byHuman: boolean): Promise<void> {
    const db = prisma();
    await db.epic.update({
      where: { id: epicId },
      data: {
        prd: prd as never,
        prdEditedByHuman: byHuman,
        status: "specified",
        stage: 2,
      },
    });
  }

  async setEpicShowcase(epicId: string, markdown: string): Promise<void> {
    const db = prisma();
    await db.epic.update({
      where: { id: epicId },
      data: { showcase: markdown, stage: 8 },
    });
  }

  async appendEvent(
    projectId: string,
    type: string,
    payload: unknown,
  ): Promise<number> {
    const db = prisma();
    const row = await db.event.create({
      data: { projectId, type, payload: payload as never },
      select: { seq: true },
    });
    return Number(row.seq);
  }

  async eventsAfter(projectId: string, seq: number, limit = 500) {
    const db = prisma();
    const rows = await db.event.findMany({
      where: { projectId, seq: { gt: BigInt(seq) } },
      orderBy: { seq: "asc" },
      take: limit,
    });
    return rows.map((r) => ({
      seq: Number(r.seq),
      type: r.type,
      payload: r.payload,
      at: r.at,
    }));
  }

  async rebalanceColumn(projectId: string, column: ColumnId): Promise<void> {
    const db = prisma();
    const cards = (await this.boardCards(projectId))
      .filter((c) => columnFor(c.status, c.stalledIn) === column)
      .sort(byPosition);

    if (!needsRebalance(cards.map((c) => c.position))) return;

    const fresh = rebalance(cards.length);
    await db.$transaction(
      cards.map((card, i) =>
        card.kind === "epic"
          ? db.epic.update({ where: { id: card.id }, data: { position: fresh[i]! } })
          : db.ticket.update({ where: { id: card.id }, data: { position: fresh[i]! } }),
      ),
    );
  }
}
