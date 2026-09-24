import "server-only";

import { normalizeRepo } from "@/lib/secrets/repo";
import { isProviderId } from "@/lib/llm/providers";

import { prisma } from "./client";
import type {
  AttachmentContent,
  AttachmentRef,
  CreateAttachmentInput,
  CreateEpicInput,
  CreateTicketInput,
  MoveInput,
  GithubProfile,
  OwnerScope,
  PresetRecord,
  ProjectSummary,
  Reroute,
  UserRecord,
  UserSecrets,
  Repository,
  RunOutcome,
  RunRecord,
  TicketDetail,
  TicketUpdate,
  AssistantMessage,
  AssistantProposal,
  CardChatMessage,
} from "./repository";
import type {
  AgentRole,
  AgentRunStatus,
  AttachmentSummary,
  BoardCard,
  AgentPreset,
  ColumnAgents,
  PlanStep,
} from "@/lib/domain/entities";
import { planStepSchema } from "@/lib/domain/entities";
import { z } from "zod";
import { type ColumnId, type TicketStatus, columnOf } from "@/lib/domain/status";
import { byPosition, needsRebalance, rebalance } from "@/lib/ordering";
import { normalizeScope } from "@/lib/domain/scope";
import { HEAT_WINDOW_MS, mergeScore } from "@/lib/colony/game";

type EpicRow = {
  id: string;
  number: number | null;
  title: string;
  status: TicketStatus;
  stalledIn: ColumnId | null;
  stage: number;
  blockedReason: string | null;
  misplacedIn: ColumnId | null;
  misplacedReason: string | null;
  standalone: boolean;
  rerouteFrom: ColumnId | null;
  rerouteReason: string | null;
  runnerJob: string | null;
  runnerJobAt: Date | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  tickets: Array<{ id: string; status: TicketStatus }>;
  runs: Array<{ role: AgentRole; model: string | null; startedAt: Date | null; createdAt: Date }>;
};

/**
 * The agent working on an Epic right now, if one is: a run still going here,
 * or a CLI agent's job still out on GitHub Actions, whose Formic run ended
 * at dispatch. Which planning agent that is follows from how far it got.
 */
function epicAgent(
  epic: EpicRow,
): { role: AgentRole; model: string | null; since: Date | null } | null {
  const live = epic.runs[0];
  if (live) return { ...live, since: live.startedAt ?? live.createdAt };
  if (!epic.runnerJob) return null;
  const role: AgentRole =
    epic.status === "merged" ? "pm" : epic.stage >= 2 ? "architect" : "product";
  return { role, model: null, since: epic.runnerJobAt };
}

function epicKey(number: number): string {
  return `EPIC-${number}`;
}

/**
 * Each Epic's number. A stored one is kept; an Epic from before numbers
 * were stored takes its place in creation order, which is what it showed
 * before, so nothing on an existing board is renamed.
 */
function epicNumbers(epics: Array<{ id: string; number: number | null; createdAt: Date }>) {
  const byAge = [...epics].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return new Map(byAge.map((e, i) => [e.id, e.number ?? i + 1]));
}

export class PrismaRepository implements Repository {
  async defaultProject(): Promise<ProjectSummary> {
    const db = prisma();
    const existing = await db.project.findFirst({
      where: { ownerId: null },
      orderBy: { createdAt: "asc" },
    });
    if (existing) {
      // A project seeded from a malformed GITHUB_REPO carries that value into
      // every GitHub API URL; heal it once rather than on every call.
      const repo =
        normalizeRepo(existing.repoFullName) ?? normalizeRepo(process.env.GITHUB_REPO);
      if (repo && repo !== existing.repoFullName) {
        return db.project.update({
          where: { id: existing.id },
          data: { repoFullName: repo },
        });
      }
      return existing;
    }

    return db.project.create({
      data: {
        name: "Formic",
        repoFullName: normalizeRepo(process.env.GITHUB_REPO) ?? "Ghigog/Formic",
        baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
      },
    });
  }

  async listProjects(scope: OwnerScope): Promise<ProjectSummary[]> {
    return prisma().project.findMany({
      where: ownerWhere(scope),
      orderBy: { createdAt: "asc" },
    });
  }

  async projectsForRepo(repoFullName: string): Promise<ProjectSummary[]> {
    return prisma().project.findMany({
      where: { repoFullName: { equals: repoFullName, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
    });
  }

  async projectById(projectId: string): Promise<ProjectSummary | null> {
    return prisma().project.findUnique({ where: { id: projectId } });
  }

  async ensureProject(input: {
    ownerId: string | null;
    repoFullName: string;
    baseBranch: string;
  }): Promise<ProjectSummary> {
    const db = prisma();
    const found = await db.project.findFirst({
      where: {
        ownerId: input.ownerId,
        repoFullName: { equals: input.repoFullName, mode: "insensitive" },
      },
      orderBy: { createdAt: "asc" },
    });
    if (found) return found;
    return db.project.create({
      data: {
        ownerId: input.ownerId,
        name: input.repoFullName.split("/")[1] ?? input.repoFullName,
        repoFullName: input.repoFullName,
        baseBranch: input.baseBranch,
      },
    });
  }

  async userById(userId: string): Promise<UserRecord | null> {
    return prisma().user.findUnique({ where: { id: userId } });
  }

  async upsertUser(profile: GithubProfile): Promise<UserRecord> {
    const { githubId, ...rest } = profile;
    return prisma().user.upsert({
      where: { githubId },
      create: profile,
      update: rest,
    });
  }

  async updateUser(userId: string, secrets: UserSecrets): Promise<UserRecord> {
    return prisma().user.update({ where: { id: userId }, data: secrets });
  }

  async countUsers(): Promise<number> {
    return prisma().user.count();
  }

  async adoptUnowned(userId: string): Promise<void> {
    const db = prisma();
    await db.$transaction([
      db.project.updateMany({ where: { ownerId: null }, data: { ownerId: userId } }),
      db.agentPreset.updateMany({ where: { ownerId: null }, data: { ownerId: userId } }),
    ]);
  }

  async projectOfCard(cardId: string): Promise<string | null> {
    const db = prisma();
    const epic = await db.epic.findUnique({
      where: { id: cardId },
      select: { projectId: true },
    });
    if (epic) return epic.projectId;
    const ticket = await db.ticket.findUnique({
      where: { id: cardId },
      select: { epic: { select: { projectId: true } } },
    });
    return ticket?.epic.projectId ?? null;
  }

  async boardCards(projectId: string): Promise<BoardCard[]> {
    const db = prisma();

    const epics = await db.epic.findMany({
      where: { projectId },
      orderBy: { position: "asc" },
      include: {
        tickets: { select: { id: true, status: true } },
        runs: {
          where: { status: { in: ["queued", "running"] } },
          orderBy: { createdAt: "desc" },
          select: { role: true, model: true, startedAt: true, createdAt: true },
        },
      },
    });

    const tickets = await db.ticket.findMany({
      where: { epic: { projectId } },
      orderBy: { position: "asc" },
      include: {
        dependsOn: { select: { dependsOnTicketId: true } },
        // Every run, newest first: the live one names the agent, the
        // oldest says when work started.
        runs: {
          orderBy: { createdAt: "desc" },
          select: { role: true, model: true, status: true, startedAt: true },
        },
      },
    });

    const numbers = epicNumbers(epics);
    // A standalone Epic is a holder, not its own card: its child ticket
    // renders alone, detached, exactly as today.
    const epicCards: BoardCard[] = epics
      .filter((epic: EpicRow) => !epic.standalone)
      .map((epic: EpicRow) => ({
        id: epic.id,
        kind: "epic" as const,
        key: epicKey(numbers.get(epic.id)!),
        title: epic.title,
        status: epic.status,
        stalledIn: epic.stalledIn,
        stage: epic.stage,
        position: epic.position,
        epicId: null,
        standalone: epic.standalone,
        rerouteFrom: epic.rerouteFrom,
        rerouteReason: epic.rerouteReason,
        size: null,
        agentRole: epicAgent(epic)?.role ?? null,
        model: epicAgent(epic)?.model ?? null,
        workingSince: epicAgent(epic)?.since?.toISOString() ?? null,
        fileScope: [],
        dependsOn: [],
        prNumber: null,
        prUrl: null,
        blockedReason: epic.blockedReason,
        misplacedIn: epic.misplacedIn,
        misplacedReason: epic.misplacedReason,
        costCents: 0,
        childCount: epic.tickets.length,
        doneCount: epic.tickets.filter((t) => t.status === "merged").length,
        createdAt: epic.createdAt.toISOString(),
        updatedAt: epic.updatedAt.toISOString(),
      }));

    const ticketCards: BoardCard[] = tickets.map((t) => {
      const live = t.runs.find((r) => r.status === "queued" || r.status === "running");
      const started = t.runs.map((r) => r.startedAt).filter((d): d is Date => !!d);
      // A CLI agent's Formic run ends at dispatch; its job on GitHub Actions
      // is the agent still at work.
      const jobRole: AgentRole | null = t.runnerJob
        ? t.status === "review"
          ? "reviewer"
          : "coder"
        : null;
      const since = live ? live.startedAt : t.runnerJob ? t.runnerJobAt : null;
      return {
      id: t.id,
      kind: "ticket" as const,
      key: t.key,
      title: t.title,
      status: t.status,
      stalledIn: t.stalledIn,
      stage: t.stage,
      position: t.position,
      epicId: t.epicId,
      detached: t.detached,
      size: t.size,
      storyPoints: t.storyPoints,
      agentRole: live?.role ?? jobRole,
      model: live?.model ?? null,
      workingSince: since?.toISOString() ?? null,
      fileScope: t.fileScope,
      dependsOn: t.dependsOn.map((d) => d.dependsOnTicketId),
      prNumber: t.prNumber,
      prUrl: t.prUrl,
      blockedReason: t.blockedReason,
      misplacedIn: t.misplacedIn,
      misplacedReason: t.misplacedReason,
      rerouteFrom: t.rerouteFrom,
      rerouteReason: t.rerouteReason,
      costCents: t.costCents,
      childCount: 0,
      doneCount: 0,
      createdAt: t.createdAt.toISOString(),
      startedAt: started.length
        ? new Date(Math.min(...started.map((d) => d.getTime()))).toISOString()
        : null,
      updatedAt: t.updatedAt.toISOString(),
      mergedAt: t.mergedAt?.toISOString() ?? null,
      mergePoints: t.mergePoints,
      mergeMultiplier: t.mergeMultiplier,
      };
    });

    return [...epicCards, ...ticketCards].sort(byPosition);
  }

  async createEpic(input: CreateEpicInput): Promise<BoardCard> {
    const db = prisma();
    const number = await this.nextEpicNumber(input.projectId);
    const epic = await db.epic.create({
      data: {
        projectId: input.projectId,
        number,
        title: input.title,
        rawRequest: input.rawRequest,
        position: input.position,
        status: "draft",
        stage: 1,
      },
    });

    return {
      id: epic.id,
      kind: "epic",
      key: epicKey(number),
      title: epic.title,
      status: epic.status,
      stalledIn: epic.stalledIn,
      stage: epic.stage,
      position: epic.position,
      epicId: null,
      standalone: false,
      rerouteFrom: null,
      rerouteReason: null,
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

  /**
   * One past the highest number the project has ever given out, deleted
   * Epics included, so a new one never repeats a key. Epics from before
   * numbers were stored are numbered first.
   */
  private async nextEpicNumber(projectId: string): Promise<number> {
    const db = prisma();
    const epics = await db.epic.findMany({
      where: { projectId },
      select: { id: true, number: true, createdAt: true },
    });
    const numbers = epicNumbers(epics);
    const unnumbered = epics.filter((e) => e.number === null);
    if (unnumbered.length > 0) {
      await db.$transaction(
        unnumbered.map((e) =>
          db.epic.update({ where: { id: e.id }, data: { number: numbers.get(e.id)! } }),
        ),
      );
    }
    const floor = Math.max(0, ...numbers.values());
    // Claimed atomically: two Epics made at once still get different numbers.
    await db.project.updateMany({
      where: { id: projectId, lastEpicNumber: { lt: floor } },
      data: { lastEpicNumber: floor },
    });
    const project = await db.project.update({
      where: { id: projectId },
      data: { lastEpicNumber: { increment: 1 } },
      select: { lastEpicNumber: true },
    });
    return project.lastEpicNumber;
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
            storyPoints: input.storyPoints ?? null,
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
        storyPoints: t.storyPoints,
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
      misplacedIn: input.misplaced?.in ?? null,
      misplacedReason: input.misplaced?.reason ?? null,
      // Out of a stall, the reason goes with it.
      ...(input.stalledIn === null ? { blockedReason: null } : {}),
    };
    if (input.kind === "epic") {
      await db.epic.update({ where: { id: input.cardId }, data });
    } else {
      await db.ticket.update({
        where: { id: input.cardId },
        data: {
          ...data,
          ...(input.detached !== undefined ? { detached: input.detached } : {}),
        },
      });
    }
  }

  async setStandalone(epicId: string, standalone: boolean): Promise<void> {
    await prisma().epic.updateMany({ where: { id: epicId }, data: { standalone } });
  }

  async setReroute(
    cardId: string,
    kind: "epic" | "ticket",
    reroute: Reroute | null,
  ): Promise<void> {
    const data = {
      rerouteFrom: reroute?.from ?? null,
      rerouteReason: reroute?.reason ?? null,
    };
    if (kind === "epic") {
      await prisma().epic.updateMany({ where: { id: cardId }, data });
    } else {
      await prisma().ticket.updateMany({ where: { id: cardId }, data });
    }
  }

  async createAttachment(input: CreateAttachmentInput): Promise<AttachmentSummary> {
    const row = await prisma().attachment.create({
      data: {
        projectId: input.projectId,
        epicId: input.epicId ?? null,
        ticketId: input.ticketId ?? null,
        requestId: input.requestId ?? null,
        filename: input.filename,
        mimeType: input.mimeType,
        kind: input.kind,
        size: input.size,
        bytes: Buffer.from(input.bytes),
      },
    });
    return toAttachmentSummary(row);
  }

  async attachmentsFor(ref: AttachmentRef): Promise<AttachmentSummary[]> {
    const rows = await prisma().attachment.findMany({
      where: attachmentRefWhere(ref),
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toAttachmentSummary);
  }

  async attachmentContent(id: string): Promise<AttachmentContent | null> {
    const row = await prisma().attachment.findUnique({
      where: { id },
      select: { bytes: true, mimeType: true },
    });
    return row ? { bytes: row.bytes, mimeType: row.mimeType } : null;
  }

  async claimAttachments(
    requestId: string,
    ref: { epicId: string } | { ticketId: string },
  ): Promise<void> {
    await prisma().attachment.updateMany({
      where: { requestId },
      data:
        "epicId" in ref
          ? { epicId: ref.epicId, requestId: null }
          : { ticketId: ref.ticketId, requestId: null },
    });
  }

  async deleteAttachments(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await prisma().attachment.deleteMany({ where: { id: { in: ids } } });
  }

  async columnPositions(projectId: string, column: ColumnId): Promise<number[]> {
    const cards = await this.boardCards(projectId);
    return cards
      .filter((c) => columnOf(c) === column)
      .map((c) => c.position)
      .sort((a, b) => a - b);
  }

  async cardById(id: string): Promise<BoardCard | null> {
    const db = prisma();
    const epic = await db.epic.findUnique({ where: { id }, select: { projectId: true } });
    if (epic) {
      // Its own project's board: any other has no such card.
      const cards = await this.boardCards(epic.projectId);
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
      select: {
        title: true,
        rawRequest: true,
        prd: true,
        prdUpdatedAt: true,
        runnerJob: true,
        issueNumber: true,
      },
    });
    return epic ?? null;
  }

  async setEpicRunnerJob(epicId: string, job: string | null): Promise<void> {
    await prisma().epic.update({
      where: { id: epicId },
      data: { runnerJob: job, runnerJobAt: job ? new Date() : null },
    });
  }

  async setEpicIssue(epicId: string, issueNumber: number): Promise<void> {
    await prisma().epic.update({ where: { id: epicId }, data: { issueNumber } });
  }

  async setEpicPrd(epicId: string, prd: unknown, byHuman: boolean): Promise<void> {
    const db = prisma();
    await db.epic.update({
      where: { id: epicId },
      data: {
        prd: prd as never,
        prdEditedByHuman: byHuman,
        prdUpdatedAt: new Date(),
        status: "specified",
        stage: 2,
        stalledIn: null,
        blockedReason: null,
        misplacedIn: null,
        misplacedReason: null,
      },
    });
  }

  async setEpicShowcase(epicId: string, markdown: string): Promise<void> {
    const db = prisma();
    await db.epic.update({
      where: { id: epicId },
      data: {
        showcase: markdown,
        stage: 8,
        stalledIn: null,
        blockedReason: null,
        misplacedIn: null,
        misplacedReason: null,
      },
    });
  }

  async deleteTickets(ticketIds: string[]): Promise<void> {
    if (ticketIds.length === 0) return;
    await prisma().ticket.deleteMany({ where: { id: { in: ticketIds } } });
  }

  async deleteEpic(epicId: string): Promise<void> {
    // Tickets, their dependencies and every run cascade with it.
    await prisma().epic.deleteMany({ where: { id: epicId } });
  }

  async stallEpic(
    epicId: string,
    stall: { status: "blocked" | "failed"; stalledIn: ColumnId; stage: number; reason: string },
  ): Promise<void> {
    await prisma().epic.updateMany({
      where: { id: epicId },
      data: {
        status: stall.status,
        stalledIn: stall.stalledIn,
        stage: stall.stage,
        blockedReason: stall.reason,
        misplacedIn: null,
        misplacedReason: null,
      },
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

  async latestEventSeq(projectId: string): Promise<number> {
    const row = await prisma().event.findFirst({
      where: { projectId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    return row ? Number(row.seq) : 0;
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

  async ticketEvents(projectId: string, ticketId: string, types: string[], limit = 200) {
    const rows = await prisma().event.findMany({
      where: { projectId, type: { in: types }, payload: { path: ["ticketId"], equals: ticketId } },
      orderBy: { seq: "desc" },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      seq: Number(r.seq),
      type: r.type,
      payload: r.payload,
      at: r.at,
    }));
  }

  async epicEvents(projectId: string, epicId: string, types: string[], limit = 200) {
    const rows = await prisma().event.findMany({
      where: { projectId, type: { in: types }, payload: { path: ["epicId"], equals: epicId } },
      orderBy: { seq: "desc" },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      seq: Number(r.seq),
      type: r.type,
      payload: r.payload,
      at: r.at,
    }));
  }

  async ticketDetail(ticketId: string): Promise<TicketDetail | null> {
    const db = prisma();
    const row = await db.ticket.findUnique({
      where: { id: ticketId },
      include: { epic: { select: { projectId: true } } },
    });
    return row ? toTicketDetail(row) : null;
  }

  async ticketByPrNumber(
    projectId: string,
    prNumber: number,
  ): Promise<TicketDetail | null> {
    const db = prisma();
    const row = await db.ticket.findFirst({
      where: { prNumber, epic: { projectId } },
      include: { epic: { select: { projectId: true } } },
    });
    return row ? toTicketDetail(row) : null;
  }

  async updateTicket(ticketId: string, update: TicketUpdate): Promise<void> {
    const db = prisma();
    const { costCents, tokensIn, tokensOut, plan, ...rest } = update;

    // The first move to merged is scored against the project's heat then.
    let merge = {};
    if (rest.status === "merged") {
      const ticket = await db.ticket.findUnique({
        where: { id: ticketId },
        select: { mergedAt: true, storyPoints: true, epic: { select: { projectId: true } } },
      });
      if (ticket && !ticket.mergedAt) {
        const now = new Date();
        const recent = await db.ticket.count({
          where: {
            epic: { projectId: ticket.epic.projectId },
            mergedAt: { gt: new Date(now.getTime() - HEAT_WINDOW_MS) },
          },
        });
        const { pts, mult } = mergeScore(ticket.storyPoints, recent);
        merge = { mergedAt: now, mergePoints: pts, mergeMultiplier: mult };
      }
    }

    await db.ticket.update({
      where: { id: ticketId },
      data: {
        ...rest,
        ...merge,
        ...(plan !== undefined ? { plan: plan as never } : {}),
        ...(rest.runnerJob !== undefined
          ? { runnerJobAt: rest.runnerJob ? new Date() : null }
          : {}),
        // A merged ticket joins its epic's group in Done, wherever it sat.
        ...(rest.status === "merged" ? { detached: false } : {}),
        // An agent moved it on: it goes where its status says.
        ...(rest.status !== undefined ? { misplacedIn: null, misplacedReason: null } : {}),
        // Spend accumulates across a ticket's runs; everything else is a set.
        ...(costCents !== undefined ? { costCents: { increment: costCents } } : {}),
        ...(tokensIn !== undefined ? { tokensIn: { increment: tokensIn } } : {}),
        ...(tokensOut !== undefined ? { tokensOut: { increment: tokensOut } } : {}),
      },
    });
  }

  async ticketsForEpic(epicId: string): Promise<TicketDetail[]> {
    const db = prisma();
    const rows = await db.ticket.findMany({
      where: { epicId },
      orderBy: { position: "asc" },
      include: { epic: { select: { projectId: true } } },
    });
    return rows.map(toTicketDetail);
  }

  async startRun(run: RunRecord): Promise<void> {
    const db = prisma();
    await db.agentRun.upsert({
      where: { id: run.id },
      create: {
        id: run.id,
        role: run.role,
        epicId: run.epicId,
        ticketId: run.ticketId,
        model: run.model,
        sandboxId: run.sandboxId,
        status: "running",
        startedAt: new Date(),
      },
      update: { sandboxId: run.sandboxId, status: "running" },
    });
  }

  async finishRun(runId: string, outcome: RunOutcome): Promise<void> {
    const db = prisma();
    await db.agentRun.updateMany({
      where: { id: runId },
      data: {
        status: outcome.status,
        error: outcome.error,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        costCents: outcome.costCents,
        finishedAt: new Date(),
      },
    });
  }

  async unfinishedRuns(
    startedBefore: Date,
  ): Promise<Array<RunRecord & { status: AgentRunStatus }>> {
    const db = prisma();
    const rows = await db.agentRun.findMany({
      where: {
        status: { in: ["queued", "running"] },
        createdAt: { lt: startedBefore },
      },
    });
    return rows.map((r: RunRow) => ({
      id: r.id,
      role: r.role,
      epicId: r.epicId,
      ticketId: r.ticketId,
      model: r.model,
      sandboxId: r.sandboxId,
      status: r.status,
    }));
  }

  async recordRunSpend(runId: string, costCents: number): Promise<void> {
    const db = prisma();
    await db.agentRun.updateMany({ where: { id: runId }, data: { costCents } });
  }

  async epicSpentCents(epicId: string): Promise<number> {
    const db = prisma();
    const result = await db.agentRun.aggregate({
      where: { epicId },
      _sum: { costCents: true },
    });
    return result._sum.costCents ?? 0;
  }

  async cancelRuns(
    scope: { runId: string } | { epicId: string } | { projectId: string },
    reason: string,
  ): Promise<Array<{ id: string; sandboxId: string | null }>> {
    const db = prisma();
    const live = { in: ["queued", "running"] as AgentRunStatus[] };
    const where =
      "runId" in scope
        ? { id: scope.runId, status: live }
        : "epicId" in scope
          ? { epicId: scope.epicId, status: live }
          : {
              status: live,
              OR: [
                { epic: { projectId: scope.projectId } },
                { ticket: { epic: { projectId: scope.projectId } } },
              ],
            };

    const rows = await db.agentRun.findMany({
      where,
      select: { id: true, sandboxId: true },
    });
    if (rows.length === 0) return [];

    await db.agentRun.updateMany({
      where: { id: { in: rows.map((r: { id: string }) => r.id) } },
      data: { status: "cancelled", error: reason, finishedAt: new Date() },
    });
    return rows;
  }

  async runCancelReason(runId: string): Promise<string | null> {
    const db = prisma();
    const row = await db.agentRun.findUnique({
      where: { id: runId },
      select: { status: true, error: true },
    });
    return row?.status === "cancelled" ? (row.error ?? "Stopped.") : null;
  }

  async listPresets(scope: OwnerScope): Promise<AgentPreset[]> {
    const rows = await prisma().agentPreset.findMany({
      where: ownerWhere(scope),
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toPreset);
  }

  async presetForRun(presetId: string) {
    const row = await prisma().agentPreset.findUnique({ where: { id: presetId } });
    return row ? { preset: toPreset(row), apiKeyCipher: row.apiKeyCipher } : null;
  }

  async savePreset(record: PresetRecord): Promise<AgentPreset> {
    const db = prisma();
    const data = {
      name: record.name,
      provider: record.provider,
      model: record.model,
      prompt: record.prompt,
      // A new key is likely a new account, with its own usage.
      ...(record.apiKeyCipher !== undefined
        ? {
            apiKeyCipher: record.apiKeyCipher,
            apiKeyHint: record.apiKeyHint ?? null,
            limitedUntil: null,
            limitNote: null,
          }
        : {}),
    };
    const row = record.id
      ? await db.agentPreset.update({ where: { id: record.id }, data })
      : await db.agentPreset.create({ data: { ...data, ownerId: record.ownerId ?? null } });
    return toPreset(row);
  }

  async setPresetLimit(presetId: string, limit: { until: Date; note: string } | null): Promise<void> {
    await prisma().agentPreset.updateMany({
      where: { id: presetId },
      data: { limitedUntil: limit?.until ?? null, limitNote: limit?.note ?? null },
    });
  }

  async deletePreset(presetId: string): Promise<void> {
    await prisma().agentPreset.deleteMany({ where: { id: presetId } });
  }

  async columnAgents(projectId: string): Promise<ColumnAgents> {
    const rows = await prisma().columnAgent.findMany({ where: { projectId } });
    return Object.fromEntries(rows.map((r) => [r.column, r.presetId]));
  }

  async setColumnAgent(
    projectId: string,
    column: ColumnId,
    presetId: string | null,
  ): Promise<void> {
    const db = prisma();
    if (presetId === null) {
      await db.columnAgent.deleteMany({ where: { projectId, column } });
      return;
    }
    await db.columnAgent.upsert({
      where: { projectId_column: { projectId, column } },
      create: { projectId, column, presetId },
      update: { presetId },
    });
  }

  async assistantAgent(projectId: string): Promise<string | null> {
    const row = await prisma().project.findUnique({
      where: { id: projectId },
      select: { assistantPresetId: true },
    });
    return row?.assistantPresetId ?? null;
  }

  async setAssistantAgent(projectId: string, presetId: string | null): Promise<void> {
    await prisma().project.update({ where: { id: projectId }, data: { assistantPresetId: presetId } });
  }

  async assistantMessages(projectId: string): Promise<AssistantMessage[]> {
    const rows = await prisma().assistantMessage.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toAssistantMessage);
  }

  async assistantMessage(id: string): Promise<AssistantMessage | null> {
    const row = await prisma().assistantMessage.findUnique({ where: { id } });
    return row ? toAssistantMessage(row) : null;
  }

  async addAssistantMessage(input: {
    projectId: string;
    role: "user" | "assistant";
    content: string;
    status?: AssistantMessage["status"];
  }): Promise<AssistantMessage> {
    const row = await prisma().assistantMessage.create({
      data: { ...input, status: input.status ?? "done" },
    });
    return toAssistantMessage(row);
  }

  async updateAssistantMessage(
    id: string,
    update: Partial<Pick<AssistantMessage, "content" | "proposals" | "status" | "runnerJob">>,
  ): Promise<void> {
    const { proposals, ...rest } = update;
    await prisma().assistantMessage.update({
      where: { id },
      data: { ...rest, ...(proposals !== undefined ? { proposals: proposals as never } : {}) },
    });
  }

  async clearAssistant(projectId: string): Promise<void> {
    await prisma().assistantMessage.deleteMany({ where: { projectId } });
  }

  async cardChatMessages(cardId: string): Promise<CardChatMessage[]> {
    const rows = await prisma().cardChatMessage.findMany({
      where: { cardId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toCardChatMessage);
  }

  async cardChatMessage(id: string): Promise<CardChatMessage | null> {
    const row = await prisma().cardChatMessage.findUnique({ where: { id } });
    return row ? toCardChatMessage(row) : null;
  }

  async addCardChatMessage(input: {
    projectId: string;
    cardKind: "epic" | "ticket";
    cardId: string;
    role: "user" | "assistant";
    content: string;
    status?: CardChatMessage["status"];
  }): Promise<CardChatMessage> {
    const row = await prisma().cardChatMessage.create({
      data: { ...input, status: input.status ?? "done" },
    });
    return toCardChatMessage(row);
  }

  async updateCardChatMessage(
    id: string,
    update: Partial<Pick<CardChatMessage, "content" | "status" | "runnerJob">>,
  ): Promise<void> {
    await prisma().cardChatMessage.update({ where: { id }, data: update });
  }

  async clearCardChat(cardId: string): Promise<void> {
    await prisma().cardChatMessage.deleteMany({ where: { cardId } });
  }

  async claimDelivery(key: string): Promise<boolean> {
    const db = prisma();
    try {
      await db.webhookDelivery.create({ data: { key } });
      return true;
    } catch {
      // The primary key is the idempotency mechanism: a duplicate insert
      // losing the race is exactly the answer we want, not an error.
      return false;
    }
  }

  async rebalanceColumn(projectId: string, column: ColumnId): Promise<void> {
    const db = prisma();
    const cards = (await this.boardCards(projectId))
      .filter((c) => columnOf(c) === column)
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

type TicketRow = {
  id: string;
  epicId: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  status: TicketStatus;
  stalledIn: ColumnId | null;
  stage: number;
  branchName: string | null;
  summary: string | null;
  prNumber: number | null;
  prUrl: string | null;
  blockedReason: string | null;
  attempts: number;
  runnerJob: string | null;
  issueNumber: number | null;
  storyPoints: number | null;
  plan: unknown;
  handoff: string[];
  reviewedSha: string | null;
  epic: { projectId: string };
};

type RunRow = {
  id: string;
  role: RunRecord["role"];
  epicId: string | null;
  ticketId: string | null;
  model: string | null;
  sandboxId: string | null;
  status: AgentRunStatus;
};

function toAssistantMessage(row: {
  id: string;
  projectId: string;
  role: string;
  content: string;
  proposals: unknown;
  status: string;
  runnerJob: string | null;
  createdAt: Date;
}): AssistantMessage {
  return {
    ...row,
    role: row.role === "user" ? "user" : "assistant",
    status: row.status === "pending" || row.status === "failed" ? row.status : "done",
    proposals: Array.isArray(row.proposals) ? (row.proposals as AssistantProposal[]) : [],
  };
}

function toCardChatMessage(row: {
  id: string;
  projectId: string;
  cardKind: string;
  cardId: string;
  role: string;
  content: string;
  status: string;
  runnerJob: string | null;
  createdAt: Date;
}): CardChatMessage {
  return {
    ...row,
    cardKind: row.cardKind === "epic" ? "epic" : "ticket",
    role: row.role === "user" ? "user" : "assistant",
    status: row.status === "pending" || row.status === "failed" ? row.status : "done",
  };
}

/** A stored plan, read defensively: it is JSON an agent wrote. */
function planOf(value: unknown): PlanStep[] {
  const parsed = z.array(planStepSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function toTicketDetail(row: TicketRow): TicketDetail {
  return {
    id: row.id,
    epicId: row.epicId,
    projectId: row.epic.projectId,
    key: row.key,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    fileScope: row.fileScope,
    status: row.status,
    stalledIn: row.stalledIn,
    stage: row.stage,
    branchName: row.branchName,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    blockedReason: row.blockedReason,
    attempts: row.attempts,
    summary: row.summary,
    runnerJob: row.runnerJob,
    issueNumber: row.issueNumber,
    storyPoints: row.storyPoints,
    plan: planOf(row.plan),
    handoff: row.handoff,
    reviewedSha: row.reviewedSha,
  };
}

function attachmentRefWhere(ref: AttachmentRef) {
  if ("epicId" in ref) return { epicId: ref.epicId };
  if ("ticketId" in ref) return { ticketId: ref.ticketId };
  return { requestId: ref.requestId };
}

function toAttachmentSummary(row: {
  id: string;
  filename: string;
  mimeType: string;
  kind: string;
  size: number;
}): AttachmentSummary {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    kind: row.kind === "image" ? "image" : "file",
    size: row.size,
    url: `/api/attachments/${row.id}`,
  };
}

/** Someone's rows, and optionally the unowned ones too. */
function ownerWhere(scope: OwnerScope) {
  return scope.includeUnowned
    ? { OR: [{ ownerId: scope.ownerId }, { ownerId: null }] }
    : { ownerId: scope.ownerId };
}

function toPreset(row: {
  id: string;
  ownerId: string | null;
  provider: string;
  name: string;
  model: string;
  prompt: string;
  apiKeyCipher: string | null;
  apiKeyHint: string | null;
  limitedUntil: Date | null;
  limitNote: string | null;
}): AgentPreset {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    // Rows from before providers existed default to Claude in the schema.
    provider: isProviderId(row.provider) ? row.provider : "anthropic",
    model: row.model,
    prompt: row.prompt,
    hasKey: row.apiKeyCipher !== null,
    keyHint: row.apiKeyHint,
    limitedUntil: row.limitedUntil?.toISOString() ?? null,
    limitNote: row.limitNote,
  };
}
