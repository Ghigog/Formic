import "server-only";

import { normalizeRepo } from "@/lib/secrets/repo";
import { isProviderId } from "@/lib/llm/providers";

import { prisma } from "./client";
import type {
  CreateEpicInput,
  CreateTicketInput,
  MoveInput,
  GithubProfile,
  OwnerScope,
  PresetRecord,
  ProjectSummary,
  UserRecord,
  UserSecrets,
  Repository,
  RunOutcome,
  RunRecord,
  TicketDetail,
  TicketUpdate,
  AssistantMessage,
  AssistantProposal,
} from "./repository";
import type {
  AgentRunStatus,
  BoardCard,
  AgentPreset,
  ColumnAgents,
} from "@/lib/domain/entities";
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
      detached: t.detached,
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
      await db.ticket.update({
        where: { id: input.cardId },
        data: {
          ...data,
          ...(input.detached !== undefined ? { detached: input.detached } : {}),
        },
      });
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
      select: { title: true, rawRequest: true, prd: true, runnerJob: true, issueNumber: true },
    });
    return epic ?? null;
  }

  async setEpicRunnerJob(epicId: string, job: string | null): Promise<void> {
    await prisma().epic.update({ where: { id: epicId }, data: { runnerJob: job } });
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
    const { costCents, tokensIn, tokensOut, ...rest } = update;

    await db.ticket.update({
      where: { id: ticketId },
      data: {
        ...rest,
        // A merged ticket joins its epic's group in Done, wherever it sat.
        ...(rest.status === "merged" ? { detached: false } : {}),
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
