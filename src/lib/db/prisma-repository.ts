import "server-only";

import { normalizeRepo } from "@/lib/secrets/repo";
import { isProviderId } from "@/lib/llm/providers";
import { PRUNABLE_EVENT_TYPES } from "@/lib/domain/events";

import { Prisma } from "@/generated/prisma/client";

import { prisma } from "./client";
import type {
  AttachmentContent,
  AttachmentRef,
  CreateAttachmentInput,
  CreateEpicInput,
  CreateTicketInput,
  MoveInput,
  TicketChange,
  TicketColumnEntry,
  GithubProfile,
  OwnerScope,
  PresetRecord,
  ProjectSummary,
  Reroute,
  LimitColumns,
  RunTimeBudgetColumns,
  UserRecord,
  PushPreferences,
  PushSubscriptionRecord,
  AccessTokenRecord,
  NewAccessToken,
  UserSecrets,
  Repository,
  RunOutcome,
  RunRecord,
  TicketDetail,
  TicketUpdate,
  AssistantMessage,
  AssistantProposal,
  CardChatMessage,
  AuditKind,
  AuditRecord,
  AuditReport,
  AuditResult,
  Rubric,
  QueenRecord,
  PlatformUsage,
  PlatformUsageTotals,
  HostUsageCheck,
  Reservation,
} from "./repository";
import { precisionChanges } from "./ticket-changes";
import type {
  AgentRole,
  AgentRunStatus,
  AttachmentSummary,
  BoardCard,
  CardKind,
  AgentPreset,
  ColumnAgents,
  ColumnOverride,
  ColumnOverrides,
  PlanStep,
  WorkType,
  BugSeverity,
} from "@/lib/domain/entities";
import { checkFollowUps } from "@/lib/agents/follow-ups";
import { planStepSchema, severityFor } from "@/lib/domain/entities";
import { DEFAULT_ALLOWANCE_WINDOW_DAYS } from "@/lib/domain/limit-settings";
import { z } from "zod";
import { type ColumnId, type TicketStatus, columnOf } from "@/lib/domain/status";
import { byPosition, needsRebalance, rebalance } from "@/lib/ordering";
import { provider as providerInfo } from "@/lib/llm/providers";
import { normalizeScope } from "@/lib/domain/scope";
import { HEAT_WINDOW_MS, mergeScore } from "@/lib/colony/game";

type EpicRow = {
  id: string;
  queen?: { id: string } | null;
  number: number | null;
  title: string;
  status: TicketStatus;
  stalledIn: ColumnId | null;
  stage: number;
  blockedReason: string | null;
  misplacedIn: ColumnId | null;
  misplacedReason: string | null;
  standalone: boolean;
  workType: WorkType | null;
  bugSeverity: BugSeverity | null;
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

/** A board with no repository is stored with a null one; callers see it empty. */
function toProjectSummary<T extends { repoFullName: string | null }>(
  row: T,
): Omit<T, "repoFullName"> & { repoFullName: string } {
  return { ...row, repoFullName: row.repoFullName ?? "" };
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
        return toProjectSummary(
          await db.project.update({
            where: { id: existing.id },
            data: { repoFullName: repo },
          }),
        );
      }
      return toProjectSummary(existing);
    }

    return toProjectSummary(
      await db.project.create({
        data: {
          name: "Formic",
          repoFullName: normalizeRepo(process.env.GITHUB_REPO) ?? "Ghigog/Formic",
          baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
        },
      }),
    );
  }

  async listProjects(scope: OwnerScope): Promise<ProjectSummary[]> {
    const rows = await prisma().project.findMany({
      where: ownerWhere(scope),
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toProjectSummary);
  }

  async projectsForRepo(repoFullName: string): Promise<ProjectSummary[]> {
    const rows = await prisma().project.findMany({
      where: { repoFullName: { equals: repoFullName, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toProjectSummary);
  }

  async projectById(projectId: string): Promise<ProjectSummary | null> {
    const row = await prisma().project.findUnique({ where: { id: projectId } });
    return row ? toProjectSummary(row) : null;
  }

  async addMember(projectId: string, userId: string): Promise<void> {
    await prisma().projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId },
      update: {},
    });
  }

  async markOpened(userId: string, projectId: string): Promise<void> {
    if ((await prisma().project.count({ where: { id: projectId } })) === 0) return;
    await prisma().projectOpen.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId },
      update: { openedAt: new Date() },
    });
  }

  async openedAtByProject(userId: string): Promise<Map<string, Date>> {
    const rows = await prisma().projectOpen.findMany({ where: { userId } });
    return new Map(rows.map((r) => [r.projectId, r.openedAt]));
  }

  async isMember(projectId: string, userId: string): Promise<boolean> {
    return (await prisma().projectMember.count({ where: { projectId, userId } })) > 0;
  }

  async memberProjects(userId: string): Promise<ProjectSummary[]> {
    const rows = await prisma().project.findMany({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toProjectSummary);
  }

  async memberAgents(projectId: string, userId: string): Promise<Record<string, string>> {
    const rows = await prisma().memberAgent.findMany({ where: { projectId, userId } });
    return Object.fromEntries(rows.map((r) => [r.slot, r.presetId]));
  }

  async setMemberAgent(projectId: string, userId: string, slot: string, presetId: string | null): Promise<void> {
    const db = prisma();
    if (presetId === null) {
      await db.memberAgent.deleteMany({ where: { projectId, userId, slot } });
      return;
    }
    await db.memberAgent.upsert({
      where: { projectId_userId_slot: { projectId, userId, slot } },
      create: { projectId, userId, slot, presetId },
      update: { presetId },
    });
  }

  async setShareKeys(projectId: string, shareKeys: boolean): Promise<void> {
    await prisma().project.updateMany({ where: { id: projectId }, data: { shareKeys } });
  }

  async cardActor(cardId: string): Promise<string | null> {
    const db = prisma();
    const ticket = await db.ticket.findUnique({
      where: { id: cardId },
      select: { actorId: true, scoutOf: true, epic: { select: { actorId: true } } },
    });
    if (!ticket) {
      return (await db.epic.findUnique({ where: { id: cardId }, select: { actorId: true } }))?.actorId ?? null;
    }
    if (ticket.actorId) return ticket.actorId;
    if (ticket.scoutOf) {
      const parent = await db.ticket.findUnique({ where: { id: ticket.scoutOf }, select: { actorId: true } });
      if (parent?.actorId) return parent.actorId;
    }
    return ticket.epic.actorId;
  }

  async setCardActor(cardId: string, userId: string | null): Promise<void> {
    const db = prisma();
    const { count } = await db.ticket.updateMany({ where: { id: cardId }, data: { actorId: userId } });
    if (count === 0) await db.epic.updateMany({ where: { id: cardId }, data: { actorId: userId } });
  }

  async reservations(repoFullName: string): Promise<Reservation[]> {
    const rows = await prisma().ticket.findMany({
      where: {
        status: "running",
        epic: { project: { repoFullName: { equals: repoFullName, mode: "insensitive" } } },
      },
      select: {
        id: true,
        key: true,
        fileScope: true,
        scoutOf: true,
        epic: { select: { projectId: true, project: { select: { owner: { select: { login: true } } } } } },
      },
    });
    // A running parent is on the same repository, so it is among the rows.
    const running = new Set(rows.map((r) => r.id));
    return rows.filter((r) => !r.scoutOf || running.has(r.scoutOf)).map((r) => ({
      ticketId: r.id,
      key: r.key,
      projectId: r.epic.projectId,
      ownerLogin: r.epic.project.owner?.login ?? null,
      fileScope: r.fileScope,
    }));
  }

  async acquireLease(key: string, holder: string, ttlMs: number): Promise<boolean> {
    // One statement, on the database's clock: instances never compare their
    // own clocks, and two asking at once cannot both win.
    const rows = await prisma().$queryRaw<Array<{ key: string }>>`
      INSERT INTO "lease" ("key", "holder", "expiresAt")
      VALUES (${key}, ${holder}, now() + ${ttlMs} * interval '1 millisecond')
      ON CONFLICT ("key") DO UPDATE SET
        "holder" = EXCLUDED."holder",
        "expiresAt" = EXCLUDED."expiresAt"
      WHERE "lease"."expiresAt" < now() OR "lease"."holder" = EXCLUDED."holder"
      RETURNING "key"`;
    return rows.length > 0;
  }

  async releaseLease(key: string, holder: string): Promise<void> {
    await prisma().lease.deleteMany({ where: { key, holder } });
  }

  async leaseHolder(key: string): Promise<string | null> {
    // On the database's clock, as acquireLease is.
    const rows = await prisma().$queryRaw<Array<{ holder: string }>>`
      SELECT "holder" FROM "lease" WHERE "key" = ${key} AND "expiresAt" >= now()`;
    return rows[0]?.holder ?? null;
  }

  async ensureProject(input: {
    ownerId: string | null;
    repoFullName: string | null;
    name?: string;
    baseBranch: string;
  }): Promise<ProjectSummary> {
    const db = prisma();
    const found =
      input.repoFullName === null
        ? null
        : await db.project.findFirst({
            where: {
              ownerId: input.ownerId,
              repoFullName: { equals: input.repoFullName, mode: "insensitive" },
            },
            orderBy: { createdAt: "asc" },
          });
    if (found) return toProjectSummary(found);
    return toProjectSummary(
      await db.project.create({
        data: {
          ownerId: input.ownerId,
          name: input.name ?? input.repoFullName?.split("/")[1] ?? input.repoFullName ?? "Board",
          repoFullName: input.repoFullName,
          baseBranch: input.baseBranch,
        },
      }),
    );
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

  async updateRunTimeBudget(userId: string, columns: RunTimeBudgetColumns): Promise<UserRecord> {
    return prisma().user.update({
      where: { id: userId },
      data: {
        ...columns,
        runTimeBudgetPerPointMinutes: columns.runTimeBudgetPerPointMinutes ?? Prisma.DbNull,
      },
    });
  }

  async updateLimits(userId: string, columns: LimitColumns): Promise<UserRecord> {
    const json = (v: Record<string, unknown> | null | undefined) =>
      v === undefined ? undefined : v === null ? Prisma.DbNull : (v as Prisma.InputJsonObject);
    return prisma().user.update({
      where: { id: userId },
      data: {
        tokenLimit: json(columns.tokenLimit),
        attemptLimit: json(columns.attemptLimit),
        effortByPoints: columns.effortByPoints,
      },
    });
  }

  async updateTokenRenewal(
    userId: string,
    renewal: { tokenRenewalDay: number | null; tokenWindowTimezone: string | null },
  ): Promise<UserRecord> {
    return prisma().user.update({ where: { id: userId }, data: renewal });
  }

  async stampTokenReset(userId: string, at: Date): Promise<UserRecord> {
    return prisma().user.update({ where: { id: userId }, data: { tokenResetAt: at } });
  }

  async acceptTerms(userId: string, version: string): Promise<UserRecord> {
    return prisma().user.update({
      where: { id: userId },
      data: { termsAcceptedVersion: version, termsAcceptedAt: new Date() },
    });
  }

  async bumpSessionVersion(userId: string): Promise<UserRecord> {
    return prisma().user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });
  }

  async addFallbackSandboxSeconds(
    userId: string,
    seconds: number,
    month: string,
  ): Promise<UserRecord> {
    return prisma().$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const carried = user.fallbackSandboxMonth === month ? user.fallbackSandboxSeconds : 0;
      return tx.user.update({
        where: { id: userId },
        data: { fallbackSandboxSeconds: carried + seconds, fallbackSandboxMonth: month },
      });
    });
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

  async createAccessToken(token: NewAccessToken): Promise<AccessTokenRecord> {
    return prisma().accessToken.create({ data: token });
  }

  async accessTokenByHash(tokenHash: string): Promise<AccessTokenRecord | null> {
    return prisma().accessToken.findUnique({ where: { tokenHash } });
  }

  async accessTokensForUser(userId: string): Promise<AccessTokenRecord[]> {
    return prisma().accessToken.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async revokeAccessToken(userId: string, id: string): Promise<boolean> {
    const { count } = await prisma().accessToken.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }

  async touchAccessToken(id: string, at: Date): Promise<void> {
    await prisma().accessToken.updateMany({ where: { id }, data: { lastUsedAt: at } });
  }

  async savePushSubscription(userId: string, subscription: PushSubscriptionRecord): Promise<void> {
    const { endpoint, p256dh, auth } = subscription;
    await prisma().pushSubscription.upsert({
      where: { endpoint },
      create: { userId, endpoint, p256dh, auth },
      update: { userId, p256dh, auth },
    });
  }

  async deletePushSubscription(endpoint: string, userId?: string): Promise<void> {
    await prisma().pushSubscription.deleteMany({ where: { endpoint, ...(userId ? { userId } : {}) } });
  }

  async pushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    return prisma().pushSubscription.findMany({
      where: { userId },
      select: { endpoint: true, p256dh: true, auth: true },
    });
  }

  async pushPreferences(userId: string): Promise<PushPreferences> {
    const user = await prisma().user.findUnique({
      where: { id: userId },
      select: { ticketMoved: true, epicCompleted: true, needsAttention: true },
    });
    return user ?? { ticketMoved: false, epicCompleted: false, needsAttention: false };
  }

  async setPushPreferences(userId: string, prefs: Partial<PushPreferences>): Promise<PushPreferences> {
    return prisma().user.update({
      where: { id: userId },
      data: prefs,
      select: { ticketMoved: true, epicCompleted: true, needsAttention: true },
    });
  }

  async deleteUser(userId: string): Promise<void> {
    // Their projects and presets cascade to everything under them: epics,
    // tickets, runs, dependencies, events, column agents, and both kinds of
    // chat message. See onDelete: Cascade in schema.prisma.
    await prisma().user.delete({ where: { id: userId } });
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

  async placeQueen(projectId: string, cardId: string, kind: CardKind): Promise<QueenRecord | null> {
    try {
      const row = await prisma().queen.create({
        data: { projectId, ...(kind === "epic" ? { epicId: cardId } : { ticketId: cardId }) },
      });
      return { projectId, cardId, kind, placedAt: row.placedAt };
    } catch (err) {
      // The card's unique slot is taken: it already has one.
      if ((err as { code?: string }).code === "P2002") return null;
      throw err;
    }
  }

  async listQueens(projectId: string): Promise<QueenRecord[]> {
    const rows = await prisma().queen.findMany({ where: { projectId }, orderBy: { placedAt: "asc" } });
    return rows.map((r) => ({
      projectId,
      cardId: (r.epicId ?? r.ticketId)!,
      kind: r.epicId ? ("epic" as const) : ("ticket" as const),
      placedAt: r.placedAt,
    }));
  }

  async clearQueen(cardId: string): Promise<boolean> {
    const db = prisma();
    const row = await db.queen.findFirst({ where: { OR: [{ epicId: cardId }, { ticketId: cardId }] } });
    if (!row) return false;
    const gone = await db.queen.deleteMany({ where: { id: row.id } });
    if (gone.count === 0) return false;
    await db.project.update({ where: { id: row.projectId }, data: { queensSpent: { increment: 1 } } });
    return true;
  }

  async queensSpent(projectId: string): Promise<number> {
    const project = await prisma().project.findUnique({ where: { id: projectId }, select: { queensSpent: true } });
    return project?.queensSpent ?? 0;
  }

  async boardCards(projectId: string): Promise<BoardCard[]> {
    return this.cards(projectId);
  }

  /**
   * The board, or one card of it. One card is read on its own: `cardById` is
   * called on most transitions and pipeline steps, and reading the whole
   * board for it (every merged ticket, every run) was most of the egress
   * left once the long text was gone.
   */
  private async cards(
    projectId: string,
    only?: { epicId: string } | { ticketId: string },
  ): Promise<BoardCard[]> {
    const db = prisma();
    const epicId = only && "epicId" in only ? only.epicId : undefined;
    const ticketId = only && "ticketId" in only ? only.ticketId : undefined;

    // Only what a card shows. The board is read on every refresh, and the
    // long text (a PRD, a request, a ticket's description and criteria) is
    // most of each row: reading it here was most of the database's egress.
    const epics = ticketId ? [] : await db.epic.findMany({
      where: { projectId, ...(epicId ? { id: epicId } : {}) },
      orderBy: { position: "asc" },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        stalledIn: true,
        stage: true,
        blockedReason: true,
        misplacedIn: true,
        misplacedReason: true,
        standalone: true,
        workType: true,
        bugSeverity: true,
        rerouteFrom: true,
        rerouteReason: true,
        runnerJob: true,
        runnerJobAt: true,
        position: true,
        createdAt: true,
        updatedAt: true,
        tickets: { where: { scoutOf: null, archived: false }, select: { id: true, status: true } },
        queen: { select: { id: true } },
        runs: {
          where: { status: { in: ["queued", "running"] } },
          orderBy: { createdAt: "desc" },
          select: { role: true, model: true, startedAt: true, createdAt: true },
        },
      },
    });

    const tickets = epicId ? [] : await db.ticket.findMany({
      where: { epic: { projectId }, archived: false, scoutOf: null, ...(ticketId ? { id: ticketId } : {}) },
      orderBy: { position: "asc" },
      select: {
        id: true,
        epicId: true,
        key: true,
        title: true,
        status: true,
        stalledIn: true,
        stage: true,
        position: true,
        detached: true,
        size: true,
        storyPoints: true,
        needsHuman: true,
        archived: true,
        workType: true,
        bugSeverity: true,
        runnerJob: true,
        runnerJobAt: true,
        fileScope: true,
        prNumber: true,
        prUrl: true,
        blockedReason: true,
        misplacedIn: true,
        misplacedReason: true,
        rerouteFrom: true,
        rerouteReason: true,
        costCents: true,
        createdAt: true,
        updatedAt: true,
        mergedAt: true,
        mergePoints: true,
        mergeMultiplier: true,
        scouts: true,
        scoutPick: true,
        dependsOn: { select: { dependsOnTicketId: true } },
        queen: { select: { id: true } },
        columnEntries: { where: { exitedAt: null }, select: { enteredAt: true }, take: 1 },
        // Only the live run, which names the agent. When work started is
        // the earliest run's start, read below as one row per ticket rather
        // than every run a ticket ever had.
        runs: {
          where: { status: { in: ["queued", "running"] } },
          orderBy: { createdAt: "desc" },
          select: { role: true, model: true, status: true, startedAt: true },
        },
      },
    });

    const firstStarts = tickets.length
      ? await db.agentRun.groupBy({
          by: ["ticketId"],
          where: { ticketId: { in: tickets.map((t) => t.id) }, startedAt: { not: null } },
          _min: { startedAt: true },
        })
      : [];
    const startedAt = new Map(firstStarts.map((r) => [r.ticketId, r._min.startedAt]));

    // A legacy Epic with no number is numbered by age among all of them.
    const numbers = epicNumbers(
      epicId && epics.some((e) => e.number === null)
        ? await db.epic.findMany({ where: { projectId }, select: { id: true, number: true, createdAt: true } })
        : epics,
    );
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
        workType: epic.workType,
        bugSeverity: epic.bugSeverity,
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
        queen: !!epic.queen,
        childCount: epic.tickets.length,
        doneCount: epic.tickets.filter((t) => t.status === "merged").length,
        createdAt: epic.createdAt.toISOString(),
        updatedAt: epic.updatedAt.toISOString(),
      }));

    const ticketCards: BoardCard[] = tickets.map((t) => {
      const live = t.runs[0];
      const started = startedAt.get(t.id) ?? null;
      // A CLI agent's Formic run ends at dispatch; its job on GitHub Actions
      // is the agent still at work.
      const jobRole: AgentRole | null = t.runnerJob
        ? t.status === "review"
          ? "reviewer"
          : t.stalledIn === "todo"
            ? "architect"
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
      needsHuman: t.needsHuman,
      archived: t.archived,
      workType: t.workType,
      bugSeverity: t.bugSeverity,
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
      queen: !!t.queen,
      childCount: 0,
      doneCount: 0,
      createdAt: t.createdAt.toISOString(),
      startedAt: started?.toISOString() ?? null,
      updatedAt: t.updatedAt.toISOString(),
      enteredAt: t.columnEntries[0]?.enteredAt.toISOString() ?? null,
      mergedAt: t.mergedAt?.toISOString() ?? null,
      mergePoints: t.mergePoints,
      mergeMultiplier: t.mergeMultiplier,
      scouts: t.scouts,
      scoutPick: t.scoutPick,
      };
    });

    return [...epicCards, ...ticketCards].sort(byPosition);
  }

  async ticketChanges(ticketId: string): Promise<TicketChange[]> {
    const rows = await prisma().ticketChange.findMany({
      where: { ticketId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    return rows.map((c) => ({
      kind: c.kind,
      at: c.at.toISOString(),
      detail: (c.detail as Record<string, unknown> | null) ?? null,
    }));
  }

  async recordTicketChange(ticketId: string, change: Pick<TicketChange, "kind" | "detail">): Promise<void> {
    await prisma().ticketChange.create({
      data: { ticketId, kind: change.kind, detail: (change.detail ?? undefined) as never },
    });
  }

  async ticketColumnEntries(ticketId: string): Promise<TicketColumnEntry[]> {
    const rows = await prisma().ticketColumnEntry.findMany({
      where: { ticketId },
      orderBy: [{ enteredAt: "asc" }, { id: "asc" }],
    });
    return rows.map((e) => ({
      column: e.column,
      enteredAt: e.enteredAt.toISOString(),
      exitedAt: e.exitedAt?.toISOString() ?? null,
      synthetic: e.synthetic,
    }));
  }

  async archivedTickets(projectId: string): Promise<BoardCard[]> {
    const db = prisma();
    const tickets = await db.ticket.findMany({
      where: { epic: { projectId }, archived: true, scoutOf: null },
      orderBy: { position: "asc" },
      select: {
        id: true,
        key: true,
        title: true,
        position: true,
        archived: true,
        workType: true,
        bugSeverity: true,
        status: true,
        stalledIn: true,
        misplacedIn: true,
        stage: true,
        epicId: true,
        size: true,
      },
    });
    // The archive list is not the board: what names the ticket, and the column it came from.
    return tickets.map((t) => ({
      id: t.id,
      kind: "ticket" as const,
      key: t.key,
      title: t.title,
      status: t.status,
      stalledIn: t.stalledIn,
      misplacedIn: t.misplacedIn,
      stage: t.stage,
      position: t.position,
      epicId: t.epicId,
      size: t.size,
      archived: t.archived,
      workType: t.workType,
      bugSeverity: t.bugSeverity,
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
    }));
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
        workType: input.workType ?? null,
        bugSeverity: severityFor(input.workType, input.bugSeverity),
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
      workType: epic.workType,
      bugSeverity: epic.bugSeverity,
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

  /**
   * The next standalone ticket's number. One past the highest the project
   * has ever given out, deleted tickets included, so a key is never reused.
   * Claimed atomically: two tickets made at once still get different numbers.
   */
  async nextStandaloneTicketNumber(projectId: string): Promise<number> {
    const db = prisma();
    const numbers = await db.ticket.findMany({
      where: { epic: { projectId, standalone: true } },
      select: { key: true },
    });
    const floor = Math.max(
      0,
      ...numbers.map((t) => Number(/^T-(\d+)$/.exec(t.key)?.[1] ?? 0)),
    );
    await db.project.updateMany({
      where: { id: projectId, lastStandaloneTicketNumber: { lt: floor } },
      data: { lastStandaloneTicketNumber: floor },
    });
    const project = await db.project.update({
      where: { id: projectId },
      data: { lastStandaloneTicketNumber: { increment: 1 } },
      select: { lastStandaloneTicketNumber: true },
    });
    return project.lastStandaloneTicketNumber;
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
            size: input.size ?? "M",
            storyPoints: input.storyPoints ?? null,
            needsHuman: input.needsHuman ?? null,
            workType: input.workType ?? null,
            bugSeverity: severityFor(input.workType, input.bugSeverity),
            position: input.position,
            status: input.dependsOnKeys.length === 0 ? "ready" : "waiting",
            stage: 3,
            columnEntries: {
              create: { column: columnOf({ status: input.dependsOnKeys.length === 0 ? "ready" : "waiting" }) },
            },
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
        needsHuman: t.needsHuman,
        workType: t.workType,
        bugSeverity: t.bugSeverity,
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
      await db.$transaction(async (tx) => {
        const before = await tx.ticket.findUnique({
          where: { id: input.cardId },
          select: {
            status: true,
            stalledIn: true,
            misplacedIn: true,
            mergedAt: true,
            storyPoints: true,
            epic: { select: { projectId: true } },
          },
        });
        // In a plain column, a person moving a card to Done scores it like a
        // merge, once.
        let merge = {};
        if (before && input.status === "merged" && !before.mergedAt && input.plain) {
          const now = new Date();
          const recent = await tx.ticket.count({
            where: {
              epic: { projectId: before.epic.projectId },
              mergedAt: { gt: new Date(now.getTime() - HEAT_WINDOW_MS) },
            },
          });
          const { pts, mult } = mergeScore(before.storyPoints, recent);
          merge = { mergedAt: now, mergePoints: pts, mergeMultiplier: mult };
        }
        await tx.ticket.update({
          where: { id: input.cardId },
          data: {
            ...data,
            ...merge,
            ...(input.detached !== undefined ? { detached: input.detached } : {}),
          },
        });
        if (!before) return;
        const to = columnOf({
          status: input.status,
          stalledIn: input.stalledIn,
          misplacedIn: input.misplaced?.in,
        });
        if (columnOf(before) === to) return;
        // One instant closes the old stay and starts the new one.
        const now = new Date();
        await tx.ticketColumnEntry.updateMany({
          where: { ticketId: input.cardId, exitedAt: null },
          data: { exitedAt: now },
        });
        await tx.ticketColumnEntry.create({
          data: { ticketId: input.cardId, column: to, enteredAt: now },
        });
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
        size: input.size ?? "M",
        bytes: Buffer.from(input.bytes),
      },
      // Without this, INSERT ... RETURNING hands the file straight back, so
      // uploading cost a second copy of its bytes in egress.
      select: ATTACHMENT_SUMMARY,
    });
    return toAttachmentSummary(row);
  }

  async attachmentsFor(ref: AttachmentRef): Promise<AttachmentSummary[]> {
    // Summary columns only, deliberately: `bytes` holds the whole file, and a
    // listing that fetched it threw it away in toAttachmentSummary anyway.
    // Every call paid for a copy of every attachment's contents.
    const rows = await prisma().attachment.findMany({
      where: attachmentRefWhere(ref),
      orderBy: { createdAt: "asc" },
      select: ATTACHMENT_SUMMARY,
    });
    return rows.map(toAttachmentSummary);
  }

  async attachmentScope(
    id: string,
  ): Promise<{ projectId: string; requestId: string | null } | null> {
    // The one query an attachment read needs to authorize itself. It used to
    // read the whole board, then every card's attachments one by one.
    const row = await prisma().attachment.findUnique({
      where: { id },
      select: { projectId: true, requestId: true },
    });
    return row ?? null;
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

  async moveTicketAttachments(fromTicketId: string, toTicketId: string): Promise<void> {
    await prisma().attachment.updateMany({ where: { ticketId: fromTicketId }, data: { ticketId: toTicketId } });
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
      const cards = await this.cards(epic.projectId, { epicId: id });
      return cards.find((c) => c.id === id) ?? null;
    }
    const ticket = await db.ticket.findUnique({
      where: { id },
      select: { epic: { select: { projectId: true } } },
    });
    if (!ticket) return null;
    const cards = await this.cards(ticket.epic.projectId, { ticketId: id });
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
        runnerAgent: true,
        issueNumber: true,
        showcase: true,
      },
    });
    return epic ?? null;
  }

  async setEpicRunnerJob(epicId: string, job: string | null, agentId: string | null = null): Promise<void> {
    await prisma().epic.update({
      where: { id: epicId },
      data: { runnerJob: job, runnerAgent: job ? agentId : null, runnerJobAt: job ? new Date() : null },
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

  async addDependencies(edges: Array<{ ticketId: string; dependsOnTicketId: string }>): Promise<void> {
    if (edges.length === 0) return;
    await prisma().ticketDependency.createMany({ data: edges, skipDuplicates: true });
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

  async addPlatformUsage(day: string, delta: PlatformUsage, sinceDay: string): Promise<PlatformUsageTotals> {
    const db = prisma();
    // One atomic increment, so instances counting at once never lose a count.
    await db.$executeRaw`
      INSERT INTO "platform_usage" ("day", "requests", "busyMs", "cpuMs", "updatedAt")
      VALUES (${day}, ${delta.requests}, ${Math.round(delta.busyMs)}, ${Math.round(delta.cpuMs)}, now())
      ON CONFLICT ("day") DO UPDATE SET
        "requests" = "platform_usage"."requests" + EXCLUDED."requests",
        "busyMs" = "platform_usage"."busyMs" + EXCLUDED."busyMs",
        "cpuMs" = "platform_usage"."cpuMs" + EXCLUDED."cpuMs",
        "updatedAt" = now()`;
    const from = day < sinceDay ? day : sinceDay;
    const rows = await db.platformUsage.findMany({ where: { day: { gte: from } } });
    const of = (r: (typeof rows)[number]) => ({
      requests: Number(r.requests),
      busyMs: Number(r.busyMs),
      cpuMs: Number(r.cpuMs),
    });
    const window = { requests: 0, busyMs: 0, cpuMs: 0 };
    let today = { requests: 0, busyMs: 0, cpuMs: 0 };
    for (const r of rows) {
      const u = of(r);
      if (r.day === day) today = u;
      if (r.day < sinceDay) continue;
      window.requests += u.requests;
      window.busyMs += u.busyMs;
      window.cpuMs += u.cpuMs;
    }
    return { today, window };
  }

  async platformUsageByDay(sinceDay: string): Promise<Record<string, PlatformUsage>> {
    const rows = await prisma().platformUsage.findMany({ where: { day: { gte: sinceDay } } });
    const out: Record<string, PlatformUsage> = {};
    for (const r of rows) {
      out[r.day] = { requests: Number(r.requests), busyMs: Number(r.busyMs), cpuMs: Number(r.cpuMs) };
    }
    return out;
  }

  async hostUsageCheck(): Promise<HostUsageCheck | null> {
    const row = await prisma().hostUsageCheck.findUnique({ where: { id: HOST_METER } });
    return row ? { checkedAt: row.checkedAt, data: row.data } : null;
  }

  async saveHostUsageCheck(check: HostUsageCheck): Promise<void> {
    const data = check.data as Prisma.InputJsonValue;
    await prisma().hostUsageCheck.upsert({
      where: { id: HOST_METER },
      create: { id: HOST_METER, checkedAt: check.checkedAt, data },
      update: { checkedAt: check.checkedAt, data },
    });
  }

  async latestEventSeq(projectId: string): Promise<number> {
    const row = await prisma().event.findFirst({
      where: { projectId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    return row ? Number(row.seq) : 0;
  }

  async pruneEvents(projectId: string, keep: number): Promise<number> {
    if (keep <= 0 || !PRUNABLE_EVENT_TYPES.length) return 0;
    const db = prisma();
    const types = [...PRUNABLE_EVENT_TYPES];
    // The cut is the `keep`-th newest frame on this board: everything older
    // than it goes, and everything after it stays. One query to find it.
    const oldestKept = await db.event.findFirst({
      where: { projectId, type: { in: types } },
      orderBy: { seq: "desc" },
      skip: keep - 1,
      select: { seq: true },
    });
    if (!oldestKept) return 0;
    const gone = await db.event.deleteMany({
      where: { projectId, type: { in: types }, seq: { lt: oldestKept.seq } },
    });
    return gone.count;
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

  async eventsOfTypes(projectIds: string[], types: string[], since: Date, limit = 200) {
    if (projectIds.length === 0) return [];
    const rows = await prisma().event.findMany({
      where: { projectId: { in: projectIds }, type: { in: types }, at: { gte: since } },
      orderBy: { seq: "desc" },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      seq: Number(r.seq),
      projectId: r.projectId,
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
    const { costCents, tokensIn, tokensOut, plan, followUps, archived, ...rest } = update;

    // A change to a ticket past its specified state is recorded as it is made.
    let changes: ReturnType<typeof precisionChanges> = [];
    if (
      rest.storyPoints !== undefined ||
      rest.title !== undefined ||
      rest.description !== undefined ||
      rest.acceptanceCriteria !== undefined ||
      rest.fileScope !== undefined
    ) {
      const before = await db.ticket.findUnique({
        where: { id: ticketId },
        select: {
          status: true,
          title: true,
          description: true,
          acceptanceCriteria: true,
          fileScope: true,
          storyPoints: true,
        },
      });
      if (before) changes = precisionChanges(before, rest);
    }

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

    // Only a bug has a severity: a type other than bug clears it.
    let severity = {};
    if (rest.workType !== undefined || rest.bugSeverity !== undefined) {
      const current = rest.workType === undefined
        ? await db.ticket.findUnique({ where: { id: ticketId }, select: { workType: true } })
        : null;
      severity = { bugSeverity: severityFor(rest.workType ?? current?.workType, rest.bugSeverity) };
    }

    await db.ticket.update({
      where: { id: ticketId },
      data: {
        ...rest,
        ...merge,
        ...severity,
        ...(rest.fileScope !== undefined ? { fileScope: normalizeScope(rest.fileScope) } : {}),
        ...(plan !== undefined ? { plan: plan as never } : {}),
        ...(followUps !== undefined ? { followUps: followUps as never } : {}),
        ...(archived !== undefined ? { archived } : {}),
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
    for (const change of changes) await this.recordTicketChange(ticketId, change);
  }

  async ticketsForEpic(epicId: string): Promise<TicketDetail[]> {
    const db = prisma();
    const rows = await db.ticket.findMany({
      where: { epicId, scoutOf: null, archived: false },
      orderBy: { position: "asc" },
      include: { epic: { select: { projectId: true } } },
    });
    return rows.map(toTicketDetail);
  }

  async createScouts(parentId: string, briefs: Array<{ brief: string; presetId: string | null }>): Promise<TicketDetail[]> {
    const db = prisma();
    const parent = await db.ticket.findUnique({ where: { id: parentId } });
    if (!parent) return [];
    const made = [];
    for (const [i, b] of briefs.entries()) {
      made.push(
        await db.ticket.create({
          data: {
            epicId: parent.epicId,
            key: `${parent.key}-s${i + 1}`,
            title: parent.title,
            description: parent.description,
            acceptanceCriteria: parent.acceptanceCriteria,
            fileScope: parent.fileScope,
            size: parent.size,
            storyPoints: parent.storyPoints,
            workType: parent.workType,
            bugSeverity: parent.bugSeverity,
            position: parent.position,
            // Inert until the parent starts and sends them out.
            status: "ready",
            stage: parent.stage,
            scoutOf: parent.id,
            scoutBrief: b.brief,
            scoutPresetId: b.presetId,
          },
          include: { epic: { select: { projectId: true } } },
        }),
      );
    }
    return made.map(toTicketDetail);
  }

  async scoutsOf(parentId: string): Promise<TicketDetail[]> {
    const rows = await prisma().ticket.findMany({
      where: { scoutOf: parentId },
      orderBy: { key: "asc" },
      include: { epic: { select: { projectId: true } } },
    });
    return rows.map(toTicketDetail);
  }

  async mirroredIssueNumbers(projectId: string): Promise<number[]> {
    const db = prisma();
    const epics = await db.epic.findMany({
      where: { projectId, issueNumber: { not: null } },
      select: { issueNumber: true },
    });
    const tickets = await db.ticket.findMany({
      where: {
        epic: { projectId },
        OR: [{ issueNumber: { not: null } }, { sourceIssueNumber: { not: null } }],
      },
      select: { issueNumber: true, sourceIssueNumber: true },
    });
    const numbers = new Set<number>();
    for (const epic of epics) if (epic.issueNumber !== null) numbers.add(epic.issueNumber);
    for (const ticket of tickets) {
      if (ticket.issueNumber !== null) numbers.add(ticket.issueNumber);
      if (ticket.sourceIssueNumber !== null) numbers.add(ticket.sourceIssueNumber);
    }
    return [...numbers];
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
        presetId: run.presetId ?? null,
        sandboxId: run.sandboxId,
        status: "running",
        startedAt: new Date(),
      },
      update: { sandboxId: run.sandboxId, status: "running" },
    });
  }

  async ticketRunMs(ticketId: string): Promise<number> {
    const rows = await prisma().agentRun.findMany({
      where: { ticketId, startedAt: { not: null } },
      select: { startedAt: true, finishedAt: true },
    });
    const now = Date.now();
    return rows.reduce((sum, r) => sum + ((r.finishedAt?.getTime() ?? now) - r.startedAt!.getTime()), 0);
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
      presetId: r.presetId,
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

  async epicRunStats(epicId: string): Promise<{ elapsedMs: number; attempts: number }> {
    const rows = await prisma().agentRun.findMany({
      where: { epicId },
      select: { status: true, startedAt: true, finishedAt: true },
    });
    const now = Date.now();
    let elapsedMs = 0;
    let attempts = 0;
    for (const r of rows as Array<{ status: AgentRunStatus; startedAt: Date | null; finishedAt: Date | null }>) {
      if (r.startedAt) elapsedMs += (r.finishedAt?.getTime() ?? now) - r.startedAt.getTime();
      if (r.status === "failed" || r.status === "blocked") attempts += 1;
    }
    return { elapsedMs, attempts };
  }

  async agentTokensByPreset(
    since?: Date | null,
  ): Promise<Record<string, { tokensIn: number; tokensOut: number }>> {
    const db = prisma();
    const started = since ? { createdAt: { gte: since } } : {};
    // Two grouped sums, because the two halves live in different tables: the
    // runs each agent drove, and the chat answers it gave, which are not runs
    // at all.
    const [runs, answers] = await Promise.all([
      db.agentRun.groupBy({
        by: ["presetId"],
        where: { presetId: { not: null }, ...started },
        _sum: { tokensIn: true, tokensOut: true },
      }),
      db.cardChatMessage.groupBy({
        by: ["agentPresetId"],
        where: { agentPresetId: { not: null }, ...started },
        _sum: { tokensIn: true, tokensOut: true },
      }),
    ]);

    const used: Record<string, { tokensIn: number; tokensOut: number }> = {};
    const add = (presetId: string | null, tokensIn: number, tokensOut: number) => {
      if (!presetId) return;
      const running = (used[presetId] ??= { tokensIn: 0, tokensOut: 0 });
      running.tokensIn += tokensIn;
      running.tokensOut += tokensOut;
    };
    for (const row of runs) add(row.presetId, row._sum?.tokensIn ?? 0, row._sum?.tokensOut ?? 0);
    for (const row of answers) add(row.agentPresetId, row._sum?.tokensIn ?? 0, row._sum?.tokensOut ?? 0);
    return used;
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
      ...(providerInfo(record.provider)?.kind !== "cli"
        ? { secretName: null }
        : record.secretName !== undefined
          ? { secretName: record.secretName }
          : {}),
      // A CLI agent's credential lives in the repository's Actions secrets,
      // never here. A new key is likely a new account, with its own usage.
      ...(providerInfo(record.provider)?.kind === "cli"
        ? { apiKeyCipher: null, apiKeyHint: null }
        : record.apiKeyCipher !== undefined
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
      : await db.agentPreset.create({
          data: { ...data, ownerId: record.ownerId ?? null, column: record.column ?? null },
        });
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

  async columnOverrides(projectId: string): Promise<ColumnOverrides> {
    const rows = await prisma().columnAgent.findMany({
      where: {
        projectId,
        OR: [{ overrideMinutes: { not: null } }, { overrideTokens: { not: null } }, { overrideAttempts: { not: null } }],
      },
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.column,
        { minutes: r.overrideMinutes, tokens: r.overrideTokens, attempts: r.overrideAttempts },
      ]),
    );
  }

  async setColumnOverride(projectId: string, column: ColumnId, override: ColumnOverride): Promise<boolean> {
    const { count } = await prisma().columnAgent.updateMany({
      where: { projectId, column },
      data: {
        overrideMinutes: override.minutes,
        overrideTokens: override.tokens,
        overrideAttempts: override.attempts,
      },
    });
    return count > 0;
  }

  async setPresetAllowance(
    presetId: string,
    allowance: { tokens: number | null; windowDays: number | null },
  ): Promise<void> {
    await prisma().agentPreset.updateMany({
      where: { id: presetId },
      data: { tokenAllowance: allowance.tokens, tokenAllowanceWindowDays: allowance.windowDays },
    });
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

  async setScoutAgent(projectId: string, presetId: string | null): Promise<void> {
    await prisma().project.update({ where: { id: projectId }, data: { scoutPresetId: presetId } });
  }

  async setAutoEscalate(projectId: string, autoEscalate: boolean): Promise<void> {
    await prisma().project.update({ where: { id: projectId }, data: { autoEscalate } });
  }

  async markTicketAutoEscalated(ticketId: string): Promise<void> {
    const { count } = await prisma().ticket.updateMany({
      where: { id: ticketId, autoEscalatedAt: null },
      data: { autoEscalatedAt: new Date() },
    });
    if (count > 0) await this.recordTicketChange(ticketId, { kind: "points", detail: { autoEscalated: true } });
  }

  async setAutoMerge(projectId: string, autoMerge: boolean): Promise<void> {
    await prisma().project.update({ where: { id: projectId }, data: { autoMerge } });
  }

  async setColony(
    projectId: string,
    colony: { colonySize: number | null; colonyReserve: number; autoScout: boolean },
  ): Promise<void> {
    await prisma().project.update({ where: { id: projectId }, data: colony });
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
    update: Partial<Pick<AssistantMessage, "content" | "proposals" | "status" | "runnerJob" | "runnerAgent">>,
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
    update: Partial<
      Pick<
        CardChatMessage,
        "content" | "status" | "runnerJob" | "agentPresetId" | "tokensIn" | "tokensOut" | "costCents"
      >
    >,
  ): Promise<void> {
    await prisma().cardChatMessage.update({ where: { id }, data: update });
  }

  async clearCardChat(cardId: string): Promise<void> {
    await prisma().cardChatMessage.deleteMany({ where: { cardId } });
  }

  async pendingCardChatJobs(projectId: string): Promise<CardChatMessage[]> {
    const rows = await prisma().cardChatMessage.findMany({
      where: { projectId, status: "pending", runnerJob: { not: null } },
    });
    return rows.map(toCardChatMessage);
  }

  async orphanedCardChats(projectId: string, olderThan: Date): Promise<CardChatMessage[]> {
    const rows = await prisma().cardChatMessage.findMany({
      where: { projectId, status: "pending", runnerJob: null, createdAt: { lt: olderThan } },
    });
    return rows.map(toCardChatMessage);
  }

  async orphanedAssistantAnswers(projectId: string, olderThan: Date): Promise<AssistantMessage[]> {
    const rows = await prisma().assistantMessage.findMany({
      where: { projectId, role: "assistant", status: "pending", runnerJob: null, createdAt: { lt: olderThan } },
    });
    return rows.map(toAssistantMessage);
  }

  async auditsFor(projectId: string): Promise<AuditRecord[]> {
    const rows = await prisma().audit.findMany({
      where: { projectId },
      orderBy: { startedAt: "asc" },
    });
    return rows.map(toAuditRecord);
  }

  async startAudit(projectId: string, sentinel: string, kind: AuditKind = "audit", rubric: Rubric | null = null, commitSha: string | null = null): Promise<AuditRecord> {
    const row = await prisma().audit.create({ data: { projectId, sentinel, kind, commitSha, rubric: (rubric ?? undefined) as never } });
    return toAuditRecord(row);
  }

  async logAudit(id: string, step: string): Promise<void> {
    await prisma().audit.update({ where: { id }, data: { log: { push: step } } });
  }

  async setAuditJob(id: string, job: string | null, agent: string | null): Promise<void> {
    await prisma().audit.update({ where: { id }, data: { runnerJob: job, runnerAgent: agent } });
  }

  async markAuditEpic(auditId: string, epicId: string): Promise<void> {
    await prisma().audit.update({ where: { id: auditId }, data: { epicId } });
  }

  async finishAudit(id: string, result: AuditResult): Promise<void> {
    const db = prisma();
    const row = await db.audit.update({
      where: { id },
      data: {
        status: result.status,
        stars: result.stars ?? null,
        quote: result.quote ?? null,
        summary: result.summary ?? null,
        report: (result.report ?? undefined) as never,
        ...(result.rubric ? { rubric: result.rubric as never } : {}),
        error: result.error ?? null,
        model: result.model ?? null,
        files: result.files ?? [],
        ...(result.commitSha !== undefined ? { commitSha: result.commitSha } : {}),
        runnerJob: null,
        runnerAgent: null,
        finishedAt: new Date(),
      },
    });
    await db.audit.deleteMany({
      where: {
        projectId: row.projectId,
        sentinel: row.sentinel,
        kind: row.kind,
        id: { not: id },
        status: result.status === "done" ? { not: "running" } : "failed",
      },
    });
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
  scopeRequest: string[];
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
  runnerAgent: string | null;
  issueNumber: number | null;
  sourceIssueNumber: number | null;
  storyPoints: number | null;
  plan: unknown;
  handoff: string[];
  followUps: unknown;
  reviewedSha: string | null;
  reviewedHead: string | null;
  stackedOn: string | null;
  autoEscalatedAt: Date | null;
  needsHuman: string | null;
  workType: WorkType | null;
  bugSeverity: BugSeverity | null;
  scoutOf: string | null;
  scoutBrief: string | null;
  scoutPresetId: string | null;
  scouts: number;
  scoutPick: string | null;
  scoutWhy: string | null;
  epic: { projectId: string };
};

type RunRow = {
  id: string;
  role: RunRecord["role"];
  epicId: string | null;
  ticketId: string | null;
  model: string | null;
  presetId: string | null;
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
  runnerAgent: string | null;
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
  agentPresetId: string | null;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
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
    scopeRequest: row.scopeRequest,
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
    runnerAgent: row.runnerAgent,
    issueNumber: row.issueNumber,
    sourceIssueNumber: row.sourceIssueNumber,
    storyPoints: row.storyPoints,
    plan: planOf(row.plan),
    handoff: row.handoff,
    followUps: checkFollowUps(row.followUps),
    reviewedSha: row.reviewedSha,
    reviewedHead: row.reviewedHead,
    stackedOn: row.stackedOn,
    autoEscalatedAt: row.autoEscalatedAt?.toISOString() ?? null,
    needsHuman: row.needsHuman,
    workType: row.workType,
    bugSeverity: row.bugSeverity,
    scoutOf: row.scoutOf,
    scoutBrief: row.scoutBrief,
    scoutPresetId: row.scoutPresetId,
    scouts: row.scouts,
    scoutPick: row.scoutPick,
    scoutWhy: row.scoutWhy,
  };
}

function attachmentRefWhere(ref: AttachmentRef) {
  if ("epicId" in ref) return { epicId: ref.epicId };
  if ("ticketId" in ref) return { ticketId: ref.ticketId };
  return { requestId: ref.requestId };
}

/**
 * The columns a listing needs. `bytes` is missing on purpose and must stay
 * missing: it is the entire file, and every route that lists attachments —
 * the gallery, the batch-limit check, a CLI agent's prompt — only ever wanted
 * the filename and size. Selecting it moved whole screenshots and archives
 * out of Postgres for nothing. The url below is derived, not a column.
 */
const ATTACHMENT_SUMMARY = {
  id: true,
  filename: true,
  mimeType: true,
  kind: true,
  size: true,
} as const;

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
  column: ColumnId | null;
  provider: string;
  name: string;
  model: string;
  prompt: string;
  apiKeyCipher: string | null;
  apiKeyHint: string | null;
  secretName: string | null;
  limitedUntil: Date | null;
  limitNote: string | null;
  tokenAllowance: number | null;
  tokenAllowanceWindowDays: number | null;
}): AgentPreset {
  return {
    id: row.id,
    ownerId: row.ownerId,
    column: row.column,
    name: row.name,
    // Rows from before providers existed default to Claude in the schema.
    provider: isProviderId(row.provider) ? row.provider : "anthropic",
    model: row.model,
    prompt: row.prompt,
    hasKey: row.apiKeyCipher !== null,
    keyHint: row.apiKeyHint,
    secretName: row.secretName,
    limitedUntil: row.limitedUntil?.toISOString() ?? null,
    limitNote: row.limitNote,
    tokenAllowance: row.tokenAllowance,
    tokenAllowanceWindowDays: row.tokenAllowanceWindowDays ?? DEFAULT_ALLOWANCE_WINDOW_DAYS,
  };
}

const auditPoint = z.object({ text: z.string(), ref: z.string().nullable() });
const auditReport = z.object({
  likes: z.array(auditPoint),
  dislikes: z.array(auditPoint),
  wrong: z.array(auditPoint),
  missing: z.array(auditPoint),
  checks: z.array(z.object({ id: z.string(), met: z.boolean(), evidence: z.string() })).optional(),
});
const rubric = z.object({
  context: z.string(),
  rungs: z.array(
    z.object({
      stars: z.number(),
      checks: z.array(z.object({ id: z.string(), text: z.string(), how: z.string() })),
    }),
  ),
});

function toAuditRecord(row: {
  id: string;
  projectId: string;
  sentinel: string;
  kind: string;
  status: string;
  log: string[];
  stars: number | null;
  quote: string | null;
  summary: string | null;
  report: unknown;
  rubric: unknown;
  error: string | null;
  model: string | null;
  files: string[];
  commitSha: string | null;
  runnerJob: string | null;
  runnerAgent: string | null;
  epicId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}): AuditRecord {
  const report = auditReport.safeParse(row.report);
  const scale = rubric.safeParse(row.rubric);
  return {
    ...row,
    kind: row.kind === "calibrate" ? "calibrate" : "audit",
    status: row.status === "done" || row.status === "failed" ? row.status : "running",
    report: report.success ? (report.data satisfies AuditReport) : null,
    rubric: scale.success ? (scale.data satisfies Rubric) : null,
  };
}

/** The one row of host_usage_check: the meter of the host this deployment runs on. */
const HOST_METER = "vercel";
