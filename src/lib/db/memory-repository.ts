import "server-only";

import { randomUUID } from "node:crypto";
import { normalizeRepo } from "@/lib/secrets/repo";
import { isPrunableEventType } from "@/lib/domain/events";

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
  AccessTokenRecord,
  NewAccessToken,
  PushPreferences,
  PushSubscriptionRecord,
  UserSecrets,
  Repository,
  RunOutcome,
  RunRecord,
  TicketDetail,
  TicketUpdate,
  AssistantMessage,
  AuditKind,
  AuditRecord,
  AuditResult,
  Rubric,
  CardChatMessage,
  GoldenBellState,
  QueenRecord,
  PlatformUsage,
  PlatformUsageTotals,
  HostUsageCheck,
  Reservation,
} from "./repository";
import { precisionChanges } from "./ticket-changes";
import type {
  AgentPreset,
  AgentRunStatus,
  AttachmentSummary,
  BoardCard,
  CardKind,
  ColumnAgents,
  ColumnOverride,
  ColumnOverrides,
  PlanStep,
} from "@/lib/domain/entities";
import type { FollowUp } from "@/lib/agents/follow-ups";
import { severityFor } from "@/lib/domain/entities";
import { DEFAULT_ALLOWANCE_WINDOW_DAYS } from "@/lib/domain/limit-settings";
import { type ColumnId, columnOf } from "@/lib/domain/status";
import { byPosition, needsRebalance, rebalance } from "@/lib/ordering";
import { provider as providerInfo } from "@/lib/llm/providers";
import { normalizeScope } from "@/lib/domain/scope";
import { HEAT_WINDOW_MS, mergeScore } from "@/lib/colony/game";

/**
 * Runs the whole board with no database. Used when DATABASE_URL is unset so a
 * fresh clone starts with `npm run dev` and nothing else.
 *
 * State lives for the lifetime of the server process: a browser reload keeps
 * the board, a server restart does not. That is the honest limit of this
 * implementation and the reason it is not the production path.
 */

let seq = 0;
let idCounter = 0;
const id = (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`;

/** The ticket fields the board does not render and so BoardCard does not carry. */
interface TicketExtras {
  description: string;
  acceptanceCriteria: string[];
  branchName: string | null;
  attempts: number;
  summary: string | null;
  runnerJob: string | null;
  /** The preset that job was dispatched with. */
  runnerAgent?: string | null;
  /** When that job was sent. */
  runnerJobAt?: Date | null;
  issueNumber: number | null;
  /** The GitHub issue this ticket was imported from, when it came in from one. */
  sourceIssueNumber?: number | null;
  plan?: PlanStep[];
  handoff?: string[];
  followUps?: FollowUp[];
  reviewedSha?: string | null;
  reviewedHead?: string | null;
  stackedOn?: string | null;
  autoEscalatedAt?: string | null;
  scopeRequest?: string[];
  /** On a scout: the ticket it scouts for, its approach and its agent template. */
  scoutOf?: string | null;
  scoutBrief?: string | null;
  scoutPresetId?: string | null;
  /** On a parent: why the pick was made. */
  scoutWhy?: string | null;
}

/** A stored file, kept alongside its bytes until fetched or claimed. */
interface AttachmentRow {
  id: string;
  projectId: string;
  epicId: string | null;
  ticketId: string | null;
  requestId: string | null;
  filename: string;
  mimeType: string;
  kind: AttachmentSummary["kind"];
  size: number;
  bytes: Uint8Array;
  createdAt: Date;
}

interface Store {
  /** Lease key to who holds it and until when (ms since epoch). */
  leases: Map<string, { holder: string; expiresAt: number }>;
  /** Host usage by UTC day, "YYYY-MM-DD". */
  platformUsage: Map<string, PlatformUsage>;
  hostUsageCheck?: HostUsageCheck;
  /** The project the demo board belongs to, and the fallback. */
  project: ProjectSummary;
  projects: Map<string, ProjectSummary>;
  /** Epic id to project id. Tickets belong to their epic's project. */
  epicProject: Map<string, string>;
  cards: Map<string, BoardCard>;
  ticketExtras: Map<string, TicketExtras>;
  /** Ticket id to its column history, oldest first. */
  columnEntries: Map<string, TicketColumnEntry[]>;
  /** Ticket id to its recorded changes, oldest first. */
  ticketChanges: Map<string, TicketChange[]>;
  prds: Map<string, unknown>;
  prdTimes: Map<string, Date>;
  rawRequests: Map<string, string>;
  showcases: Map<string, string>;
  epicJobs: Map<string, string>;
  epicJobAgents: Map<string, string | null>;
  epicJobTimes: Map<string, Date>;
  epicIssues: Map<string, number>;
  /** The highest Epic number each project has used, deleted ones included. */
  epicNumbers: Map<string, number>;
  /** The highest standalone ticket number each project has used, deleted ones included. */
  standaloneTicketNumbers: Map<string, number>;
  /** Card id to the Queen on it. */
  queens: Map<string, QueenRecord>;
  /** Queens each project has taken off, by project id. */
  queensSpent: Map<string, number>;
  /** Golden bells each project has used, by project id. */
  goldenBellsUsed: Map<string, number>;
  /** Projects with an armed golden bell. */
  goldenBellsArmed: Set<string>;
  events: Array<{
    seq: number;
    projectId: string;
    type: string;
    payload: unknown;
    at: Date;
  }>;
  runs: Map<
    string,
    RunRecord & {
      status: AgentRunStatus;
      startedAt: Date;
      finishedAt?: Date | null;
      costCents: number;
      error: string | null;
      /** What it used, so an agent's own tokens can be summed from here. */
      tokensIn: number;
      tokensOut: number;
    }
  >;
  deliveries: Set<string>;
  presets: Map<string, AgentPreset & { apiKeyCipher: string | null }>;
  users: Map<string, UserRecord>;
  /** endpoint to the subscription and the person it belongs to. */
  pushSubscriptions: Map<string, PushSubscriptionRecord & { userId: string }>;
  accessTokens: Map<string, AccessTokenRecord>;
  /** `${projectId}:${column}` to preset id. */
  columnAgents: Map<string, string>;
  /** `${projectId}:${column}` to that column agent's override. */
  columnOverrides: Map<string, ColumnOverride>;
  /** `${projectId}:${userId}` for each person a project is shared with. */
  members: Set<string>;
  /** `${userId}:${projectId}` to when that person last opened it. */
  opens: Map<string, Date>;
  /** `${projectId}:${userId}:${slot}` to a member's own preset id. */
  memberAgents: Map<string, string>;
  /** Card id to whose keys its work runs on. */
  actors: Map<string, string>;
  assistant: AssistantMessage[];
  cardChat: CardChatMessage[];
  attachments: Map<string, AttachmentRow>;
  audits: AuditRecord[];
}

declare global {
  var __formicMemoryStore: Store | undefined;
}

function store(): Store {
  const existing = globalThis.__formicMemoryStore;
  if (existing) {
    // A store from before presets existed survives a dev-server reload.
    existing.presets ??= new Map();
    existing.columnAgents ??= new Map();
    existing.columnOverrides ??= new Map();
    existing.users ??= new Map();
    existing.pushSubscriptions ??= new Map();
    existing.accessTokens ??= new Map();
    existing.epicNumbers ??= new Map();
    existing.standaloneTicketNumbers ??= new Map();
    existing.queens ??= new Map();
    existing.queensSpent ??= new Map();
    existing.goldenBellsUsed ??= new Map();
    existing.goldenBellsArmed ??= new Set();
    existing.prdTimes ??= new Map();
    existing.epicJobTimes ??= new Map();
    existing.epicJobAgents ??= new Map();
    existing.attachments ??= new Map();
    existing.audits ??= [];
    existing.platformUsage ??= new Map();
    existing.leases ??= new Map();
    existing.members ??= new Set();
    existing.opens ??= new Map();
    existing.memberAgents ??= new Map();
    existing.actors ??= new Map();
    return existing;
  }
  const project: ProjectSummary = {
    id: "project_default",
    ownerId: null,
    name: "Formic",
    repoFullName: normalizeRepo(process.env.GITHUB_REPO) ?? "Ghigog/Formic",
    baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
    autoMerge: false,
    autoEscalate: false,
    colonySize: null,
    colonyReserve: 0,
    autoScout: false,
    scoutPresetId: null,
    shareKeys: false,
  };
  const s: Store = {
    project,
    projects: new Map([[project.id, project]]),
    epicProject: new Map(),
    cards: new Map(),
    ticketExtras: new Map(),
    columnEntries: new Map(),
    ticketChanges: new Map(),
    prds: new Map(),
    prdTimes: new Map(),
    rawRequests: new Map(),
    showcases: new Map(),
    epicJobs: new Map(),
    epicJobAgents: new Map(),
    epicJobTimes: new Map(),
    epicIssues: new Map(),
    epicNumbers: new Map(),
    standaloneTicketNumbers: new Map(),
    queens: new Map(),
    queensSpent: new Map(),
    goldenBellsUsed: new Map(),
    goldenBellsArmed: new Set(),
    events: [],
    platformUsage: new Map(),
    leases: new Map(),
    runs: new Map(),
    deliveries: new Set(),
    presets: new Map(),
    users: new Map(),
    pushSubscriptions: new Map(),
    accessTokens: new Map(),
    columnAgents: new Map(),
    columnOverrides: new Map(),
    members: new Set(),
    opens: new Map(),
    memberAgents: new Map(),
    actors: new Map(),
    assistant: [],
    cardChat: [],
    attachments: new Map(),
    audits: [],
  };
  globalThis.__formicMemoryStore = s;
  return s;
}

/** The project a card belongs to. Seeded cards belong to the default one. */
/**
 * A ticket's column history. A ticket that has none (the demo board's, made
 * before any was recorded) gets one synthetic open entry for where it is,
 * as the migration does for existing rows.
 */
function historyOf(s: Store, card: BoardCard): TicketColumnEntry[] {
  let history = s.columnEntries.get(card.id);
  if (!history) {
    const column = columnOf(card);
    history = [
      {
        column,
        enteredAt: (column === "backlog" ? card.createdAt : card.updatedAt) ?? new Date().toISOString(),
        exitedAt: null,
        synthetic: true,
      },
    ];
    s.columnEntries.set(card.id, history);
  }
  return history;
}

function projectOf(s: Store, card: BoardCard): string {
  const epicId = card.kind === "epic" ? card.id : card.epicId;
  return (epicId && s.epicProject.get(epicId)) || s.project.id;
}

/** Scores a ticket's merge against its project's heat now, and stamps it. */
function stampMerge(s: Store, card: BoardCard): void {
  const now = Date.now();
  const project = projectOf(s, card);
  const recent = [...s.cards.values()].filter(
    (c) =>
      c.mergedAt &&
      projectOf(s, c) === project &&
      new Date(c.mergedAt).getTime() > now - HEAT_WINDOW_MS,
  ).length;
  const { pts, mult } = mergeScore(card.storyPoints, recent);
  card.mergedAt = new Date(now).toISOString();
  card.mergePoints = pts;
  card.mergeMultiplier = mult;
}

/** The project a run belongs to, by its Epic or, failing that, its ticket's. */
function projectOfRun(s: Store, run: { epicId: string | null; ticketId: string | null }): string | null {
  const epicId = run.epicId ?? (run.ticketId ? s.cards.get(run.ticketId)?.epicId : undefined);
  return (epicId && s.epicProject.get(epicId)) || null;
}

export function seedMemory(
  cards: BoardCard[],
  /** What a demo ticket says and the plan its agent is on, by card id. */
  details: Record<string, { description: string; acceptanceCriteria: string[]; plan?: PlanStep[] }> = {},
): void {
  const s = store();
  if (s.cards.size > 0) return;
  for (const card of cards) s.cards.set(card.id, { ...card });
  for (const [cardId, d] of Object.entries(details)) {
    s.ticketExtras.set(cardId, {
      description: d.description,
      acceptanceCriteria: d.acceptanceCriteria,
      plan: d.plan,
      branchName: null,
      attempts: 0,
      summary: null,
      runnerJob: null,
      issueNumber: null,
    });
  }
}

/** Cards whose agent was set from a run or a runner job, to clear when it ends. */
const fromJob = new WeakSet<BoardCard>();

export class MemoryRepository implements Repository {
  async defaultProject(): Promise<ProjectSummary> {
    return store().project;
  }

  async listProjects(scope: OwnerScope): Promise<ProjectSummary[]> {
    return [...store().projects.values()].filter((p) => inScope(p.ownerId, scope));
  }

  async projectsForRepo(repoFullName: string): Promise<ProjectSummary[]> {
    return [...store().projects.values()].filter(
      (p) => p.repoFullName.toLowerCase() === repoFullName.toLowerCase(),
    );
  }

  async userById(userId: string): Promise<UserRecord | null> {
    return store().users.get(userId) ?? null;
  }

  async upsertUser(profile: GithubProfile): Promise<UserRecord> {
    const s = store();
    const found = [...s.users.values()].find((u) => u.githubId === profile.githubId);
    if (found) {
      Object.assign(found, profile);
      return found;
    }
    const user: UserRecord = {
      id: id("user"),
      ...profile,
      githubTokenCipher: null,
      githubTokenExpiresAt: null,
      githubRefreshCipher: null,
      githubRefreshExpiresAt: null,
      e2bKeyCipher: null,
      e2bKeyHint: null,
      anthropicKeyCipher: null,
      anthropicKeyHint: null,
      termsAcceptedVersion: null,
      sessionVersion: 0,
      fallbackSandboxSeconds: 0,
      fallbackSandboxMonth: null,
      runTimeBudgetMode: "PER_STORY_POINT",
      runTimeBudgetFlatMinutes: null,
      runTimeBudgetPerPointMinutes: null,
      runTimeBudgetPerPointRate: null,
      tokenLimit: null,
      attemptLimit: null,
      effortByPoints: true,
      tokenRenewalDay: null,
      tokenWindowTimezone: null,
      tokenResetAt: null,
    };
    s.users.set(user.id, user);
    return user;
  }

  async updateUser(userId: string, secrets: UserSecrets): Promise<UserRecord> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    Object.assign(user, secrets);
    return user;
  }

  async updateRunTimeBudget(userId: string, columns: RunTimeBudgetColumns): Promise<UserRecord> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    Object.assign(user, columns);
    return user;
  }

  async updateLimits(userId: string, columns: LimitColumns): Promise<UserRecord> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    if (columns.tokenLimit !== undefined) user.tokenLimit = columns.tokenLimit;
    if (columns.attemptLimit !== undefined) user.attemptLimit = columns.attemptLimit;
    if (columns.effortByPoints !== undefined) user.effortByPoints = columns.effortByPoints;
    return user;
  }

  async updateTokenRenewal(
    userId: string,
    renewal: { tokenRenewalDay: number | null; tokenWindowTimezone: string | null },
  ): Promise<UserRecord> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    Object.assign(user, renewal);
    return user;
  }

  async stampTokenReset(userId: string, at: Date): Promise<UserRecord> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    user.tokenResetAt = at;
    return user;
  }

  async acceptTerms(userId: string, version: string): Promise<UserRecord> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    user.termsAcceptedVersion = version;
    return user;
  }

  async bumpSessionVersion(userId: string): Promise<UserRecord> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    user.sessionVersion += 1;
    return user;
  }

  async addFallbackSandboxSeconds(
    userId: string,
    seconds: number,
    month: string,
  ): Promise<UserRecord> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    const carried = user.fallbackSandboxMonth === month ? user.fallbackSandboxSeconds : 0;
    user.fallbackSandboxSeconds = carried + seconds;
    user.fallbackSandboxMonth = month;
    return user;
  }

  async countUsers(): Promise<number> {
    return store().users.size;
  }

  async adoptUnowned(userId: string): Promise<void> {
    const s = store();
    for (const p of s.projects.values()) if (p.ownerId === null) p.ownerId = userId;
    for (const p of s.presets.values()) if (p.ownerId === null) p.ownerId = userId;
  }

  async deleteUser(userId: string): Promise<void> {
    const s = store();
    const projectIds = [...s.projects.values()]
      .filter((p) => p.ownerId === userId)
      .map((p) => p.id);
    for (const projectId of projectIds) {
      for (const card of [...s.cards.values()]) {
        if (card.kind === "epic" && projectOf(s, card) === projectId) {
          await this.deleteEpic(card.id);
        }
      }
      for (const key of [...s.columnAgents.keys()]) {
        if (key.startsWith(`${projectId}:`)) s.columnAgents.delete(key);
      }
      for (const key of [...s.columnOverrides.keys()]) {
        if (key.startsWith(`${projectId}:`)) s.columnOverrides.delete(key);
      }
      s.events = s.events.filter((e) => e.projectId !== projectId);
      s.assistant = s.assistant.filter((m) => m.projectId !== projectId);
      s.cardChat = s.cardChat.filter((m) => m.projectId !== projectId);
      s.audits = s.audits.filter((a) => a.projectId !== projectId);
      s.epicNumbers.delete(projectId);
      s.standaloneTicketNumbers.delete(projectId);
      s.queensSpent.delete(projectId);
      s.goldenBellsUsed.delete(projectId);
      s.goldenBellsArmed.delete(projectId);
      s.projects.delete(projectId);
    }
    for (const preset of [...s.presets.values()]) {
      if (preset.ownerId === userId) await this.deletePreset(preset.id);
    }
    s.users.delete(userId);
    for (const [endpoint, sub] of s.pushSubscriptions) {
      if (sub.userId === userId) s.pushSubscriptions.delete(endpoint);
    }
    for (const [id, token] of s.accessTokens) {
      if (token.userId === userId) s.accessTokens.delete(id);
    }
  }

  async projectById(projectId: string): Promise<ProjectSummary | null> {
    return store().projects.get(projectId) ?? null;
  }

  async addMember(projectId: string, userId: string): Promise<void> {
    store().members.add(`${projectId}:${userId}`);
  }

  async markOpened(userId: string, projectId: string): Promise<void> {
    const s = store();
    if (!s.projects.has(projectId)) return;
    s.opens.set(`${userId}:${projectId}`, new Date());
  }

  async openedAtByProject(userId: string): Promise<Map<string, Date>> {
    const prefix = `${userId}:`;
    return new Map(
      [...store().opens].filter(([k]) => k.startsWith(prefix)).map(([k, at]) => [k.slice(prefix.length), at]),
    );
  }

  async createAccessToken(token: NewAccessToken): Promise<AccessTokenRecord> {
    const record: AccessTokenRecord = { ...token, id: randomUUID(), revokedAt: null, createdAt: new Date(), lastUsedAt: null };
    store().accessTokens.set(record.id, record);
    return { ...record };
  }

  async accessTokenByHash(tokenHash: string): Promise<AccessTokenRecord | null> {
    const found = [...store().accessTokens.values()].find((t) => t.tokenHash === tokenHash);
    return found ? { ...found } : null;
  }

  async accessTokensForUser(userId: string): Promise<AccessTokenRecord[]> {
    return [...store().accessTokens.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((t) => ({ ...t }));
  }

  async revokeAccessToken(userId: string, id: string): Promise<boolean> {
    const found = store().accessTokens.get(id);
    if (!found || found.userId !== userId || found.revokedAt) return false;
    found.revokedAt = new Date();
    return true;
  }

  async touchAccessToken(id: string, at: Date): Promise<void> {
    const found = store().accessTokens.get(id);
    if (found) found.lastUsedAt = at;
  }

  async savePushSubscription(userId: string, subscription: PushSubscriptionRecord): Promise<void> {
    const { endpoint, p256dh, auth } = subscription;
    store().pushSubscriptions.set(endpoint, { userId, endpoint, p256dh, auth });
  }

  async deletePushSubscription(endpoint: string, userId?: string): Promise<void> {
    const s = store();
    const found = s.pushSubscriptions.get(endpoint);
    if (found && (userId === undefined || found.userId === userId)) s.pushSubscriptions.delete(endpoint);
  }

  async pushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    return [...store().pushSubscriptions.values()]
      .filter((p) => p.userId === userId)
      .map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }));
  }

  async pushPreferences(userId: string): Promise<PushPreferences> {
    const user = store().users.get(userId);
    return {
      ticketMoved: user?.ticketMoved ?? true,
      epicCompleted: user?.epicCompleted ?? true,
      needsAttention: user?.needsAttention ?? true,
    };
  }

  async setPushPreferences(userId: string, prefs: Partial<PushPreferences>): Promise<PushPreferences> {
    const user = store().users.get(userId);
    if (!user) throw new Error(`No user ${userId}.`);
    Object.assign(user, prefs);
    return this.pushPreferences(userId);
  }

  async isMember(projectId: string, userId: string): Promise<boolean> {
    return store().members.has(`${projectId}:${userId}`);
  }

  async memberProjects(userId: string): Promise<ProjectSummary[]> {
    const s = store();
    return [...s.projects.values()].filter((p) => s.members.has(`${p.id}:${userId}`));
  }

  async memberAgents(projectId: string, userId: string): Promise<Record<string, string>> {
    const prefix = `${projectId}:${userId}:`;
    const out: Record<string, string> = {};
    for (const [k, v] of store().memberAgents) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    return out;
  }

  async setMemberAgent(projectId: string, userId: string, slot: string, presetId: string | null): Promise<void> {
    const key = `${projectId}:${userId}:${slot}`;
    if (presetId === null) store().memberAgents.delete(key);
    else store().memberAgents.set(key, presetId);
  }

  async setShareKeys(projectId: string, shareKeys: boolean): Promise<void> {
    const project = store().projects.get(projectId);
    if (project) project.shareKeys = shareKeys;
  }

  async cardActor(cardId: string): Promise<string | null> {
    const s = store();
    const own = s.actors.get(cardId);
    if (own) return own;
    const card = s.cards.get(cardId);
    if (!card || card.kind !== "ticket") return null;
    const parent = s.ticketExtras.get(cardId)?.scoutOf;
    const fromParent = parent ? s.actors.get(parent) : undefined;
    if (fromParent) return fromParent;
    return card.epicId ? (s.actors.get(card.epicId) ?? null) : null;
  }

  async setCardActor(cardId: string, userId: string | null): Promise<void> {
    if (userId === null) store().actors.delete(cardId);
    else store().actors.set(cardId, userId);
  }

  async reservations(repoFullName: string): Promise<Reservation[]> {
    const s = store();
    const projects = new Map((await this.projectsForRepo(repoFullName)).map((p) => [p.id, p]));
    const held: Reservation[] = [];
    for (const card of s.cards.values()) {
      if (card.kind !== "ticket" || card.status !== "running") continue;
      const project = projects.get(projectOf(s, card));
      if (!project) continue;
      const parentId = s.ticketExtras.get(card.id)?.scoutOf;
      if (parentId && s.cards.get(parentId)?.status !== "running") continue;
      held.push({
        ticketId: card.id,
        key: card.key,
        projectId: project.id,
        ownerLogin: project.ownerId ? (s.users.get(project.ownerId)?.login ?? null) : null,
        fileScope: [...card.fileScope],
      });
    }
    return held;
  }

  async acquireLease(key: string, holder: string, ttlMs: number): Promise<boolean> {
    const s = store();
    const now = Date.now();
    const held = s.leases.get(key);
    if (held && held.holder !== holder && held.expiresAt > now) return false;
    s.leases.set(key, { holder, expiresAt: now + ttlMs });
    return true;
  }

  async releaseLease(key: string, holder: string): Promise<void> {
    const s = store();
    if (s.leases.get(key)?.holder === holder) s.leases.delete(key);
  }

  async leaseHolder(key: string): Promise<string | null> {
    const held = store().leases.get(key);
    return held && held.expiresAt > Date.now() ? held.holder : null;
  }

  async ensureProject(input: {
    ownerId: string | null;
    repoFullName: string | null;
    name?: string;
    baseBranch: string;
  }): Promise<ProjectSummary> {
    const s = store();
    const wanted = input.repoFullName?.toLowerCase();
    const found =
      wanted === undefined
        ? undefined
        : [...s.projects.values()].find(
            (p) => p.ownerId === input.ownerId && p.repoFullName.toLowerCase() === wanted,
          );
    if (found) return found;
    const project: ProjectSummary = {
      id: id("project"),
      ownerId: input.ownerId,
      name: input.name ?? input.repoFullName?.split("/")[1] ?? input.repoFullName ?? "Board",
      repoFullName: input.repoFullName ?? "",
      baseBranch: input.baseBranch,
      autoMerge: false,
      autoEscalate: false,
      colonySize: null,
      colonyReserve: 0,
      autoScout: false,
      scoutPresetId: null,
      shareKeys: false,
    };
    s.projects.set(project.id, project);
    return project;
  }

  async projectOfCard(cardId: string): Promise<string | null> {
    const s = store();
    const card = s.cards.get(cardId);
    return card ? projectOf(s, card) : null;
  }

  async placeQueen(projectId: string, cardId: string, kind: CardKind): Promise<QueenRecord | null> {
    const s = store();
    if (s.queens.has(cardId)) return null;
    const queen = { projectId, cardId, kind, placedAt: new Date() };
    s.queens.set(cardId, queen);
    return queen;
  }

  async listQueens(projectId: string): Promise<QueenRecord[]> {
    return [...store().queens.values()].filter((q) => q.projectId === projectId);
  }

  async clearQueen(cardId: string): Promise<boolean> {
    const s = store();
    const queen = s.queens.get(cardId);
    if (!queen) return false;
    s.queens.delete(cardId);
    s.queensSpent.set(queen.projectId, (s.queensSpent.get(queen.projectId) ?? 0) + 1);
    return true;
  }

  async goldenBell(projectId: string): Promise<GoldenBellState> {
    const s = store();
    return { used: s.goldenBellsUsed.get(projectId) ?? 0, armed: s.goldenBellsArmed.has(projectId) };
  }

  async setGoldenBellArmed(projectId: string, armed: boolean): Promise<void> {
    const s = store();
    if (!s.projects.has(projectId)) return;
    if (armed) s.goldenBellsArmed.add(projectId);
    else s.goldenBellsArmed.delete(projectId);
  }

  async useGoldenBell(projectId: string): Promise<boolean> {
    const s = store();
    if (!s.goldenBellsArmed.delete(projectId)) return false;
    s.goldenBellsUsed.set(projectId, (s.goldenBellsUsed.get(projectId) ?? 0) + 1);
    return true;
  }

  async queensSpent(projectId: string): Promise<number> {
    return store().queensSpent.get(projectId) ?? 0;
  }

  async ticketColumnEntries(ticketId: string): Promise<TicketColumnEntry[]> {
    const s = store();
    const card = s.cards.get(ticketId);
    return card && card.kind === "ticket" ? historyOf(s, card).map((e) => ({ ...e })) : [];
  }

  async ticketChanges(ticketId: string): Promise<TicketChange[]> {
    return (store().ticketChanges.get(ticketId) ?? []).map((c) => ({ ...c }));
  }

  async recordTicketChange(ticketId: string, change: Pick<TicketChange, "kind" | "detail">): Promise<void> {
    const s = store();
    if (!s.cards.has(ticketId)) return;
    const list = s.ticketChanges.get(ticketId) ?? [];
    list.push({ ...change, at: new Date().toISOString() });
    s.ticketChanges.set(ticketId, list);
  }

  async boardCards(projectId?: string): Promise<BoardCard[]> {
    const s = store();
    // Scouts are never board cards: their parent shows them.
    const cards = [...s.cards.values()].filter(
      (c) => (projectId === undefined || projectOf(s, c) === projectId) && !isScout(s, c),
    );
    // Runs still going here, by the card they are for.
    const live = new Map<string, { role: BoardCard["agentRole"]; since: Date }>();
    for (const run of s.runs.values()) {
      if (run.status !== "running" && run.status !== "queued") continue;
      const id = run.ticketId ?? run.epicId;
      if (id) live.set(id, { role: run.role, since: run.startedAt });
    }
    for (const card of cards) {
      card.queen = s.queens.has(card.id);
      if (card.kind === "ticket") card.enteredAt = historyOf(s, card).at(-1)?.enteredAt ?? null;
      // An agent at work: a run here, or a CLI agent's job on GitHub Actions,
      // whose run here ends at dispatch.
      const job =
        card.kind === "epic"
          ? s.epicJobs.has(card.id)
            ? {
                role:
                  card.status === "merged"
                    ? ("pm" as const)
                    : card.stage >= 2
                      ? ("architect" as const)
                      : ("product" as const),
                since: s.epicJobTimes.get(card.id) ?? null,
              }
            : null
          : s.ticketExtras.get(card.id)?.runnerJob
            ? {
                role: card.status === "review" ? ("reviewer" as const) : card.stalledIn === "todo" ? ("architect" as const) : ("coder" as const),
                since: s.ticketExtras.get(card.id)?.runnerJobAt ?? null,
              }
            : null;
      const working = live.get(card.id) ?? job;
      if (working) {
        card.agentRole = working.role;
        card.workingSince = working.since?.toISOString() ?? null;
        fromJob.add(card);
      } else if (fromJob.delete(card)) {
        card.agentRole = null;
        card.workingSince = null;
      }
      if (card.kind !== "epic") continue;
      const children = cards.filter((c) => c.epicId === card.id && !c.archived);
      card.childCount = children.length;
      card.doneCount = children.filter((c) => c.status === "merged").length;
    }
    // A standalone Epic is a holder, not its own card: its child ticket
    // renders alone, detached, exactly as today. Archived tickets stay in
    // the archive, off the board.
    return cards
      .filter((c) => !(c.kind === "epic" && c.standalone))
      .filter((c) => !(c.kind === "ticket" && c.archived))
      .sort(byPosition);
  }

  async archivedTickets(projectId: string): Promise<BoardCard[]> {
    const s = store();
    return [...s.cards.values()]
      .filter((c) => c.kind === "ticket" && c.archived && projectOf(s, c) === projectId && !isScout(s, c))
      .sort(byPosition);
  }

  async createEpic(input: CreateEpicInput): Promise<BoardCard> {
    const s = store();
    // One past the highest ever used, so a deleted Epic's key is never reused.
    const n =
      Math.max(
        s.epicNumbers.get(input.projectId) ?? 0,
        ...(await this.boardCards(input.projectId))
          .filter((c) => c.kind === "epic")
          .map((c) => Number(c.key.replace(/^EPIC-/, "")) || 0),
      ) + 1;
    s.epicNumbers.set(input.projectId, n);
    const card: BoardCard = {
      id: id("epic"),
      kind: "epic",
      key: `EPIC-${n}`,
      title: input.title,
      status: "draft",
      stalledIn: null,
      stage: 1,
      position: input.position,
      epicId: null,
      standalone: false,
      workType: input.workType ?? null,
      bugSeverity: severityFor(input.workType, input.bugSeverity),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    s.cards.set(card.id, card);
    s.epicProject.set(card.id, input.projectId);
    s.rawRequests.set(card.id, input.rawRequest);
    return card;
  }

  /**
   * The next standalone ticket's number. One past the highest ever used, so
   * a deleted ticket's key is never reused.
   */
  async nextStandaloneTicketNumber(projectId: string): Promise<number> {
    const s = store();
    const n =
      Math.max(
        s.standaloneTicketNumbers.get(projectId) ?? 0,
        ...(await this.boardCards(projectId))
          .map((c) => Number(/^T-(\d+)$/.exec(c.key)?.[1] ?? 0)),
      ) + 1;
    s.standaloneTicketNumbers.set(projectId, n);
    return n;
  }

  async createTickets(inputs: CreateTicketInput[]): Promise<BoardCard[]> {
    const s = store();
    const made = new Map<string, BoardCard>();

    for (const input of inputs) {
      const card: BoardCard = {
        id: id("ticket"),
        kind: "ticket",
        key: input.key,
        title: input.title,
        status: input.dependsOnKeys.length === 0 ? "ready" : "waiting",
        stalledIn: null,
        stage: 3,
        position: input.position,
        epicId: input.epicId,
        size: input.size ?? "M",
        storyPoints: input.storyPoints ?? null,
        needsHuman: input.needsHuman ?? null,
        workType: input.workType ?? null,
        bugSeverity: severityFor(input.workType, input.bugSeverity),
        agentRole: null,
        model: null,
        fileScope: normalizeScope(input.fileScope),
        dependsOn: [],
        prNumber: null,
        prUrl: null,
        blockedReason: null,
        rerouteFrom: null,
        rerouteReason: null,
        costCents: 0,
        childCount: 0,
        doneCount: 0,
        createdAt: new Date().toISOString(),
        startedAt: null,
        updatedAt: new Date().toISOString(),
      };
      made.set(input.key, card);
      s.columnEntries.set(card.id, [
        { column: columnOf(card), enteredAt: card.createdAt!, exitedAt: null, synthetic: false },
      ]);
      s.ticketExtras.set(card.id, {
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
        branchName: null,
        attempts: 0,
        summary: null,
        runnerJob: null,
        issueNumber: null,
      });
    }

    for (const input of inputs) {
      const card = made.get(input.key);
      if (!card) continue;
      card.dependsOn = input.dependsOnKeys
        .map((k) => made.get(k)?.id)
        .filter((v): v is string => !!v);
      s.cards.set(card.id, card);
    }

    return [...made.values()];
  }

  async move(input: MoveInput): Promise<void> {
    const card = store().cards.get(input.cardId);
    if (!card) return;
    if (card.kind === "ticket") {
      const s = store();
      const history = historyOf(s, card);
      const to = columnOf({
        status: input.status,
        stalledIn: input.stalledIn,
        misplacedIn: input.misplaced?.in,
      });
      if (history.at(-1)?.column !== to) {
        const now = new Date().toISOString();
        const open = history.at(-1);
        if (open) open.exitedAt = now;
        history.push({ column: to, enteredAt: now, exitedAt: null, synthetic: false });
      }
    }
    if (card.status !== input.status) {
      card.updatedAt = new Date().toISOString();
      if (input.status === "running" && !card.startedAt) card.startedAt = card.updatedAt;
    }
    // In a plain column, a person moving a card to Done scores it like a
    // merge, once.
    if (card.kind === "ticket" && input.status === "merged" && !card.mergedAt && input.plain) {
      stampMerge(store(), card);
    }
    card.status = input.status;
    card.stalledIn = input.stalledIn;
    card.position = input.position;
    card.misplacedIn = input.misplaced?.in ?? null;
    card.misplacedReason = input.misplaced?.reason ?? null;
    // Out of a stall, the reason goes with it.
    if (input.stalledIn === null) card.blockedReason = null;
    if (input.detached !== undefined) card.detached = input.detached;
  }

  async setStandalone(epicId: string, standalone: boolean): Promise<void> {
    const card = store().cards.get(epicId);
    if (card) card.standalone = standalone;
  }

  async setReroute(
    cardId: string,
    _kind: "epic" | "ticket",
    reroute: Reroute | null,
  ): Promise<void> {
    const card = store().cards.get(cardId);
    if (!card) return;
    card.rerouteFrom = reroute?.from ?? null;
    card.rerouteReason = reroute?.reason ?? null;
  }

  async createAttachment(input: CreateAttachmentInput): Promise<AttachmentSummary> {
    const row: AttachmentRow = {
      id: id("attachment"),
      projectId: input.projectId,
      epicId: input.epicId ?? null,
      ticketId: input.ticketId ?? null,
      requestId: input.requestId ?? null,
      filename: input.filename,
      mimeType: input.mimeType,
      kind: input.kind,
      size: input.size ?? "M",
      bytes: input.bytes,
      createdAt: new Date(),
    };
    store().attachments.set(row.id, row);
    return toAttachmentSummary(row);
  }

  async attachmentsFor(ref: AttachmentRef): Promise<AttachmentSummary[]> {
    return [...store().attachments.values()]
      .filter((a) => matchesAttachmentRef(a, ref))
      .map(toAttachmentSummary);
  }

  async attachmentScope(
    id: string,
  ): Promise<{ projectId: string; requestId: string | null } | null> {
    const row = store().attachments.get(id);
    return row ? { projectId: row.projectId, requestId: row.requestId } : null;
  }

  async attachmentContent(id: string): Promise<AttachmentContent | null> {
    const row = store().attachments.get(id);
    return row ? { bytes: row.bytes, mimeType: row.mimeType } : null;
  }

  async claimAttachments(
    requestId: string,
    ref: { epicId: string } | { ticketId: string },
  ): Promise<void> {
    for (const row of store().attachments.values()) {
      if (row.requestId !== requestId) continue;
      row.requestId = null;
      if ("epicId" in ref) row.epicId = ref.epicId;
      else row.ticketId = ref.ticketId;
    }
  }

  async moveTicketAttachments(fromTicketId: string, toTicketId: string): Promise<void> {
    for (const row of store().attachments.values()) {
      if (row.ticketId === fromTicketId) row.ticketId = toTicketId;
    }
  }

  async deleteAttachments(ids: string[]): Promise<void> {
    const s = store();
    for (const id of ids) s.attachments.delete(id);
  }

  async columnPositions(projectId: string, column: ColumnId): Promise<number[]> {
    return (await this.boardCards(projectId))
      .filter((c) => columnOf(c) === column)
      .map((c) => c.position)
      .sort((a, b) => a - b);
  }

  async cardById(cardId: string): Promise<BoardCard | null> {
    const s = store();
    const card = s.cards.get(cardId);
    if (card?.kind === "ticket") card.enteredAt = historyOf(s, card).at(-1)?.enteredAt ?? null;
    return card ?? null;
  }

  async epicDetail(epicId: string) {
    const s = store();
    const card = s.cards.get(epicId);
    if (!card) return null;
    return {
      title: card.title,
      rawRequest: s.rawRequests.get(epicId) ?? card.title,
      prd: s.prds.get(epicId) ?? null,
      prdUpdatedAt: s.prdTimes.get(epicId) ?? null,
      runnerJob: s.epicJobs.get(epicId) ?? null,
      runnerAgent: s.epicJobAgents.get(epicId) ?? null,
      issueNumber: s.epicIssues.get(epicId) ?? null,
      showcase: s.showcases.get(epicId) ?? null,
    };
  }

  async setEpicIssue(epicId: string, issueNumber: number): Promise<void> {
    store().epicIssues.set(epicId, issueNumber);
  }

  async setEpicRunnerJob(epicId: string, job: string | null, agentId: string | null = null): Promise<void> {
    const s = store();
    if (job) {
      s.epicJobs.set(epicId, job);
      s.epicJobAgents.set(epicId, agentId);
      s.epicJobTimes.set(epicId, new Date());
    } else {
      s.epicJobs.delete(epicId);
      s.epicJobAgents.delete(epicId);
      s.epicJobTimes.delete(epicId);
    }
  }

  async setEpicPrd(epicId: string, prd: unknown): Promise<void> {
    const s = store();
    s.prds.set(epicId, prd);
    s.prdTimes.set(epicId, new Date());
    const card = s.cards.get(epicId);
    if (card) {
      card.status = "specified";
      card.stage = 2;
      card.stalledIn = null;
      card.blockedReason = null;
      card.misplacedIn = null;
      card.misplacedReason = null;
    }
  }

  async setEpicShowcase(epicId: string, markdown: string): Promise<void> {
    const s = store();
    s.showcases.set(epicId, markdown);
    const card = s.cards.get(epicId);
    if (card) {
      card.stage = 8;
      card.stalledIn = null;
      card.blockedReason = null;
      card.misplacedIn = null;
      card.misplacedReason = null;
    }
  }

  async deleteTickets(ticketIds: string[]): Promise<void> {
    const s = store();
    for (const id of ticketIds) {
      s.cards.delete(id);
      s.queens.delete(id);
      s.ticketExtras.delete(id);
    }
    for (const card of s.cards.values()) {
      card.dependsOn = card.dependsOn.filter((id) => s.cards.has(id));
    }
    for (const [runId, run] of s.runs) {
      if (run.ticketId && !s.cards.has(run.ticketId)) s.runs.delete(runId);
    }
  }

  async addDependencies(edges: Array<{ ticketId: string; dependsOnTicketId: string }>): Promise<void> {
    const s = store();
    for (const edge of edges) {
      const card = s.cards.get(edge.ticketId);
      if (card && !card.dependsOn.includes(edge.dependsOnTicketId)) {
        card.dependsOn.push(edge.dependsOnTicketId);
      }
    }
  }

  async deleteEpic(epicId: string): Promise<void> {
    const s = store();
    for (const card of [...s.cards.values()]) {
      if (card.epicId !== epicId) continue;
      s.cards.delete(card.id);
      s.queens.delete(card.id);
      s.ticketExtras.delete(card.id);
    }
    for (const card of s.cards.values()) {
      card.dependsOn = card.dependsOn.filter((id) => s.cards.has(id));
    }
    for (const [runId, run] of s.runs) {
      if (run.epicId === epicId || (run.ticketId && !s.cards.has(run.ticketId))) {
        s.runs.delete(runId);
      }
    }
    s.cards.delete(epicId);
    s.queens.delete(epicId);
    s.epicProject.delete(epicId);
    s.rawRequests.delete(epicId);
    s.prds.delete(epicId);
    s.showcases.delete(epicId);
    s.epicJobs.delete(epicId);
    s.epicIssues.delete(epicId);
  }

  async stallEpic(
    epicId: string,
    stall: { status: "blocked" | "failed"; stalledIn: ColumnId; stage: number; reason: string },
  ): Promise<void> {
    const card = store().cards.get(epicId);
    if (!card) return;
    card.status = stall.status;
    card.stalledIn = stall.stalledIn;
    card.stage = stall.stage;
    card.blockedReason = stall.reason;
    card.misplacedIn = null;
    card.misplacedReason = null;
  }

  async appendEvent(
    projectId: string,
    type: string,
    payload: unknown,
  ): Promise<number> {
    const s = store();
    const next = ++seq;
    s.events.push({ seq: next, projectId, type, payload, at: new Date() });
    // Bounded: this is a demo store, not a durable log.
    if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
    return next;
  }

  async eventsAfter(projectId: string, after: number, limit = 500) {
    return store()
      .events.filter((e) => e.projectId === projectId && e.seq > after)
      .slice(0, limit)
      .map(({ seq, type, payload, at }) => ({ seq, type, payload, at }));
  }

  async ticketEvents(projectId: string, ticketId: string, types: string[], limit = 200) {
    return store()
      .events.filter(
        (e) =>
          e.projectId === projectId &&
          types.includes(e.type) &&
          (e.payload as { ticketId?: unknown } | null)?.ticketId === ticketId,
      )
      .slice(-limit)
      .map(({ seq, type, payload, at }) => ({ seq, type, payload, at }));
  }

  async cardStatusBefore(projectId: string, cardId: string, beforeSeq: number) {
    const found = store()
      .events.filter(
        (e) =>
          e.projectId === projectId &&
          e.type === "card.status" &&
          e.seq < beforeSeq &&
          (e.payload as { cardId?: unknown } | null)?.cardId === cardId,
      )
      .at(-1);
    return found?.payload ?? null;
  }

  async epicEvents(projectId: string, epicId: string, types: string[], limit = 200) {
    return store()
      .events.filter(
        (e) =>
          e.projectId === projectId &&
          types.includes(e.type) &&
          (e.payload as { epicId?: unknown } | null)?.epicId === epicId,
      )
      .slice(-limit)
      .map(({ seq, type, payload, at }) => ({ seq, type, payload, at }));
  }

  async addPlatformUsage(day: string, delta: PlatformUsage, sinceDay: string): Promise<PlatformUsageTotals> {
    const days = store().platformUsage;
    const was = days.get(day) ?? { requests: 0, busyMs: 0, cpuMs: 0 };
    days.set(day, {
      requests: was.requests + delta.requests,
      busyMs: was.busyMs + delta.busyMs,
      cpuMs: was.cpuMs + delta.cpuMs,
    });
    const window = { requests: 0, busyMs: 0, cpuMs: 0 };
    for (const [d, u] of days) {
      if (d < sinceDay) continue;
      window.requests += u.requests;
      window.busyMs += u.busyMs;
      window.cpuMs += u.cpuMs;
    }
    return { today: { ...days.get(day)! }, window };
  }

  async platformUsageByDay(sinceDay: string): Promise<Record<string, PlatformUsage>> {
    const out: Record<string, PlatformUsage> = {};
    for (const [d, u] of store().platformUsage) if (d >= sinceDay) out[d] = { ...u };
    return out;
  }

  async hostUsageCheck(): Promise<HostUsageCheck | null> {
    return store().hostUsageCheck ?? null;
  }

  async saveHostUsageCheck(check: HostUsageCheck): Promise<void> {
    store().hostUsageCheck = check;
  }

  async eventsOfTypes(projectIds: string[], types: string[], since: Date, limit = 200) {
    return store()
      .events.filter((e) => projectIds.includes(e.projectId) && types.includes(e.type) && e.at >= since)
      .slice(-limit)
      .map(({ seq, projectId, type, payload, at }) => ({ seq, projectId, type, payload, at }));
  }

  async latestEventSeq(projectId: string): Promise<number> {
    const mine = store().events.filter((e) => e.projectId === projectId);
    return mine.at(-1)?.seq ?? 0;
  }

  /**
   * The demo store already keeps only the last 2000 frames it was ever
   * given (`appendEvent`), so this normally has nothing to do. It is here
   * because the contract is the same for both stores, and a caller asking
   * for a smaller bound than that must get one.
   */
  async pruneEvents(projectId: string, keep: number): Promise<number> {
    if (keep <= 0) return 0;
    const s = store();
    const mine = s.events.filter(
      (e) => e.projectId === projectId && isPrunableEventType(e.type),
    );
    const cut = mine.at(-keep)?.seq;
    if (cut === undefined) return 0;
    const kept = s.events.filter(
      (e) =>
        !(e.projectId === projectId && isPrunableEventType(e.type) && e.seq < cut),
    );
    const gone = s.events.length - kept.length;
    s.events.length = 0;
    s.events.push(...kept);
    return gone;
  }

  async ticketDetail(ticketId: string): Promise<TicketDetail | null> {
    const s = store();
    const card = s.cards.get(ticketId);
    if (!card || card.kind !== "ticket") return null;
    return toDetail(card, s.ticketExtras.get(ticketId), projectOf(s, card));
  }

  async ticketByPrNumber(
    projectId: string,
    prNumber: number,
  ): Promise<TicketDetail | null> {
    const s = store();
    for (const card of s.cards.values()) {
      if (
        card.kind === "ticket" &&
        card.prNumber === prNumber &&
        projectOf(s, card) === projectId
      ) {
        return toDetail(card, s.ticketExtras.get(card.id), projectId);
      }
    }
    return null;
  }

  async updateTicket(ticketId: string, update: TicketUpdate): Promise<void> {
    const s = store();
    const card = s.cards.get(ticketId);
    if (!card) return;

    const extrasBefore = s.ticketExtras.get(ticketId);
    if (extrasBefore) {
      for (const change of precisionChanges(
        {
          status: card.status,
          title: card.title,
          description: extrasBefore.description,
          acceptanceCriteria: extrasBefore.acceptanceCriteria,
          fileScope: card.fileScope,
          storyPoints: card.storyPoints ?? null,
        },
        update,
      )) {
        await this.recordTicketChange(ticketId, change);
      }
    }

    if (update.workType !== undefined || update.bugSeverity !== undefined) {
      if (update.workType !== undefined) card.workType = update.workType;
      card.bugSeverity = severityFor(card.workType, update.bugSeverity !== undefined ? update.bugSeverity : card.bugSeverity);
    }
    if (update.status !== undefined && update.status !== card.status) {
      card.updatedAt = new Date().toISOString();
      if (update.status === "running" && !card.startedAt) card.startedAt = card.updatedAt;
    }
    // The first move to merged is scored against the project's heat then.
    if (update.status === "merged" && !card.mergedAt) {
      stampMerge(s, card);
    }
    if (update.status !== undefined) {
      card.status = update.status;
      // An agent moved it on: it goes where its status says.
      card.misplacedIn = null;
      card.misplacedReason = null;
    }
    // A merged ticket joins its epic's group in Done, wherever it sat.
    if (update.status === "merged") card.detached = false;
    if (update.stalledIn !== undefined) card.stalledIn = update.stalledIn;
    if (update.stage !== undefined) card.stage = update.stage;
    if (update.title !== undefined) card.title = update.title;
    if (update.fileScope !== undefined) card.fileScope = normalizeScope(update.fileScope);
    if (update.storyPoints !== undefined) card.storyPoints = update.storyPoints;
    if (update.needsHuman !== undefined) card.needsHuman = update.needsHuman;
    if (update.archived !== undefined) card.archived = update.archived;
    if (update.prNumber !== undefined) card.prNumber = update.prNumber;
    if (update.prUrl !== undefined) card.prUrl = update.prUrl;
    if (update.blockedReason !== undefined) {
      card.blockedReason = update.blockedReason;
    }
    if (update.costCents !== undefined) card.costCents += update.costCents;
    if (update.scouts !== undefined) card.scouts = update.scouts;
    if (update.scoutPick !== undefined) card.scoutPick = update.scoutPick;

    const extras = s.ticketExtras.get(ticketId);
    if (!extras) return;
    if (update.description !== undefined) extras.description = update.description;
    if (update.acceptanceCriteria !== undefined) extras.acceptanceCriteria = update.acceptanceCriteria;
    if (update.branchName !== undefined) extras.branchName = update.branchName;
    if (update.attempts !== undefined) extras.attempts = update.attempts;
    if (update.summary !== undefined) extras.summary = update.summary;
    if (update.runnerJob !== undefined) {
      extras.runnerJob = update.runnerJob;
      extras.runnerJobAt = update.runnerJob ? new Date() : null;
    }
    if (update.runnerAgent !== undefined) extras.runnerAgent = update.runnerAgent;
    if (update.issueNumber !== undefined) extras.issueNumber = update.issueNumber;
    if (update.sourceIssueNumber !== undefined) extras.sourceIssueNumber = update.sourceIssueNumber;
    if (update.plan !== undefined) extras.plan = update.plan;
    if (update.handoff !== undefined) extras.handoff = update.handoff;
    if (update.followUps !== undefined) extras.followUps = update.followUps;
    if (update.reviewedSha !== undefined) extras.reviewedSha = update.reviewedSha;
    if (update.reviewedHead !== undefined) extras.reviewedHead = update.reviewedHead;
    if (update.stackedOn !== undefined) extras.stackedOn = update.stackedOn;
    if (update.scopeRequest !== undefined) extras.scopeRequest = update.scopeRequest;
    if (update.scoutWhy !== undefined) extras.scoutWhy = update.scoutWhy;
  }

  async ticketsForEpic(epicId: string): Promise<TicketDetail[]> {
    const s = store();
    return [...s.cards.values()]
      .filter((c) => c.kind === "ticket" && c.epicId === epicId && !c.archived && !isScout(s, c))
      .sort(byPosition)
      .map((c) => toDetail(c, s.ticketExtras.get(c.id), projectOf(s, c)));
  }

  async createScouts(parentId: string, briefs: Array<{ brief: string; presetId: string | null }>): Promise<TicketDetail[]> {
    const s = store();
    const parent = s.cards.get(parentId);
    const extras = s.ticketExtras.get(parentId);
    if (!parent || parent.kind !== "ticket" || !extras) return [];
    const made: TicketDetail[] = [];
    for (const [i, b] of briefs.entries()) {
      const now = new Date().toISOString();
      const card: BoardCard = {
        ...parent,
        id: id("ticket"),
        key: `${parent.key}-s${i + 1}`,
        // Inert until the parent starts and sends them out.
        status: "ready",
        stalledIn: null,
        dependsOn: [],
        prNumber: null,
        prUrl: null,
        blockedReason: null,
        costCents: 0,
        queen: false,
        scouts: 0,
        scoutPick: null,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      };
      s.cards.set(card.id, card);
      s.ticketExtras.set(card.id, {
        description: extras.description,
        acceptanceCriteria: [...extras.acceptanceCriteria],
        branchName: null,
        attempts: 0,
        summary: null,
        runnerJob: null,
        issueNumber: null,
        scoutOf: parentId,
        scoutBrief: b.brief,
        scoutPresetId: b.presetId,
      });
      made.push(toDetail(card, s.ticketExtras.get(card.id), projectOf(s, card)));
    }
    return made;
  }

  async scoutsOf(parentId: string): Promise<TicketDetail[]> {
    const s = store();
    return [...s.cards.values()]
      .filter((c) => s.ticketExtras.get(c.id)?.scoutOf === parentId)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((c) => toDetail(c, s.ticketExtras.get(c.id), projectOf(s, c)));
  }

  async mirroredIssueNumbers(projectId: string): Promise<number[]> {
    const s = store();
    const numbers = new Set<number>();
    for (const card of s.cards.values()) {
      if (projectOf(s, card) !== projectId) continue;
      if (card.kind === "epic") {
        const issue = s.epicIssues.get(card.id);
        if (issue !== undefined) numbers.add(issue);
        continue;
      }
      const extras = s.ticketExtras.get(card.id);
      if (extras?.issueNumber != null) numbers.add(extras.issueNumber);
      if (extras?.sourceIssueNumber != null) numbers.add(extras.sourceIssueNumber);
    }
    return [...numbers];
  }

  async startRun(run: RunRecord): Promise<void> {
    const s = store();
    // Called again to attach a sandbox once the run is under way: its
    // already-accrued spend and start time must survive that, or a restart
    // of the same call resets an Epic's running total to zero.
    const existing = s.runs.get(run.id);
    s.runs.set(run.id, {
      ...run,
      status: "running",
      startedAt: existing?.startedAt ?? new Date(),
      costCents: existing?.costCents ?? 0,
      error: existing?.error ?? null,
      // What it used is only known when it finishes; the tokens it has
      // already reported must not be reset by a second start call.
      tokensIn: existing?.tokensIn ?? 0,
      tokensOut: existing?.tokensOut ?? 0,
    });
  }

  async finishRun(runId: string, outcome: RunOutcome): Promise<void> {
    const run = store().runs.get(runId);
    if (run) {
      run.status = outcome.status;
      run.finishedAt = new Date();
      run.error = outcome.error;
      run.costCents = outcome.costCents;
      run.tokensIn = outcome.tokensIn;
      run.tokensOut = outcome.tokensOut;
      run.finishedAt = new Date();
    }
  }

  async ticketRunMs(ticketId: string): Promise<number> {
    const now = Date.now();
    return [...store().runs.values()]
      .filter((r) => r.ticketId === ticketId)
      .reduce((sum, r) => sum + ((r.finishedAt?.getTime() ?? now) - r.startedAt.getTime()), 0);
  }

  async unfinishedRuns(
    startedBefore: Date,
  ): Promise<Array<RunRecord & { status: AgentRunStatus }>> {
    return [...store().runs.values()].filter(
      (r) =>
        (r.status === "queued" || r.status === "running") &&
        r.startedAt < startedBefore,
    );
  }

  async recordRunSpend(runId: string, costCents: number): Promise<void> {
    const run = store().runs.get(runId);
    if (run) run.costCents = costCents;
  }

  async epicSpentCents(epicId: string): Promise<number> {
    let total = 0;
    for (const run of store().runs.values()) {
      if (run.epicId === epicId) total += run.costCents;
    }
    return total;
  }

  async epicRunStats(epicId: string): Promise<{ elapsedMs: number; attempts: number }> {
    const now = Date.now();
    let elapsedMs = 0;
    let attempts = 0;
    for (const run of store().runs.values()) {
      if (run.epicId !== epicId) continue;
      elapsedMs += (run.finishedAt?.getTime() ?? now) - run.startedAt.getTime();
      if (run.status === "failed" || run.status === "blocked") attempts += 1;
    }
    return { elapsedMs, attempts };
  }

  async agentTokensByPreset(
    since?: Date | null,
  ): Promise<Record<string, { tokensIn: number; tokensOut: number }>> {
    const used: Record<string, { tokensIn: number; tokensOut: number }> = {};
    const add = (presetId: string | null, tokensIn: number, tokensOut: number) => {
      if (!presetId) return;
      const running = (used[presetId] ??= { tokensIn: 0, tokensOut: 0 });
      running.tokensIn += tokensIn;
      running.tokensOut += tokensOut;
    };
    for (const run of store().runs.values()) {
      if (since && run.startedAt < since) continue;
      add(run.presetId ?? null, run.tokensIn, run.tokensOut);
    }
    // An answer is not a run, so what it used is on the message instead.
    for (const message of store().cardChat) {
      if (since && message.createdAt < since) continue;
      add(message.agentPresetId, message.tokensIn, message.tokensOut);
    }
    return used;
  }

  async cancelRuns(
    scope: { runId: string } | { epicId: string } | { projectId: string },
    reason: string,
  ): Promise<Array<{ id: string; sandboxId: string | null }>> {
    const s = store();
    const cancelled: Array<{ id: string; sandboxId: string | null }> = [];
    for (const run of s.runs.values()) {
      if (run.status !== "queued" && run.status !== "running") continue;
      const matches =
        "runId" in scope
          ? run.id === scope.runId
          : "epicId" in scope
            ? run.epicId === scope.epicId
            : projectOfRun(s, run) === scope.projectId;
      if (!matches) continue;
      run.status = "cancelled";
      run.finishedAt = new Date();
      run.error = reason;
      cancelled.push({ id: run.id, sandboxId: run.sandboxId });
    }
    return cancelled;
  }

  async runCancelReason(runId: string): Promise<string | null> {
    const run = store().runs.get(runId);
    return run && run.status === "cancelled" ? (run.error ?? "Stopped.") : null;
  }

  async auditsFor(projectId: string): Promise<AuditRecord[]> {
    return store()
      .audits.filter((a) => a.projectId === projectId)
      .map((a) => ({ ...a, log: [...a.log], files: [...a.files] }));
  }

  async startAudit(projectId: string, sentinel: string, kind: AuditKind = "audit", rubric: Rubric | null = null, commitSha: string | null = null): Promise<AuditRecord> {
    const audit: AuditRecord = {
      id: `audit_${Math.random().toString(36).slice(2, 10)}`,
      projectId,
      sentinel,
      kind,
      status: "running",
      log: [],
      stars: null,
      quote: null,
      summary: null,
      report: null,
      rubric,
      error: null,
      model: null,
      files: [],
      commitSha,
      runnerJob: null,
      runnerAgent: null,
      epicId: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    store().audits.push(audit);
    return { ...audit, log: [], files: [] };
  }

  async auditDetail(id: string): Promise<AuditRecord | null> {
    const a = store().audits.find((x) => x.id === id);
    return a ? { ...a, log: [...a.log], files: [...a.files] } : null;
  }

  async logAudit(id: string, step: string, replace = false): Promise<void> {
    const audit = store().audits.find((a) => a.id === id);
    if (!audit) return;
    if (replace && audit.log.length > 0) audit.log[audit.log.length - 1] = step;
    else audit.log.push(step);
  }

  async setAuditJob(id: string, job: string | null, agent: string | null): Promise<void> {
    const audit = store().audits.find((a) => a.id === id);
    if (audit) Object.assign(audit, { runnerJob: job, runnerAgent: agent });
  }

  async markAuditEpic(auditId: string, epicId: string): Promise<void> {
    const audit = store().audits.find((a) => a.id === auditId);
    if (audit) audit.epicId = epicId;
  }

  async finishAudit(id: string, result: AuditResult): Promise<void> {
    const s = store();
    const audit = s.audits.find((a) => a.id === id);
    if (!audit) return;
    Object.assign(audit, {
      status: result.status,
      stars: result.stars ?? null,
      quote: result.quote ?? null,
      summary: result.summary ?? null,
      report: result.report ?? null,
      rubric: result.rubric ?? audit.rubric,
      error: result.error ?? null,
      model: result.model ?? null,
      files: result.files ?? [],
      commitSha: result.commitSha === undefined ? audit.commitSha : result.commitSha,
      runnerJob: null,
      runnerAgent: null,
      finishedAt: new Date(),
    });
    s.audits = s.audits.filter(
      (a) =>
        a === audit ||
        a.projectId !== audit.projectId ||
        a.sentinel !== audit.sentinel ||
        a.kind !== audit.kind ||
        a.status === "running" ||
        (result.status === "failed" && a.status === "done"),
    );
  }

  async claimDelivery(key: string): Promise<boolean> {
    const s = store();
    if (s.deliveries.has(key)) return false;
    s.deliveries.add(key);
    // Bounded, like the event log: this is a demo store.
    if (s.deliveries.size > 5000) {
      const oldest = s.deliveries.values().next().value;
      if (oldest) s.deliveries.delete(oldest);
    }
    return true;
  }

  async listPresets(scope: OwnerScope): Promise<AgentPreset[]> {
    return [...store().presets.values()]
      .filter((p) => inScope(p.ownerId, scope))
      .map(publicPreset);
  }

  async presetForRun(presetId: string) {
    const row = store().presets.get(presetId);
    return row ? { preset: publicPreset(row), apiKeyCipher: row.apiKeyCipher } : null;
  }

  async savePreset(record: PresetRecord): Promise<AgentPreset> {
    const s = store();
    const existing = record.id ? s.presets.get(record.id) : undefined;
    const cli = providerInfo(record.provider)?.kind === "cli";
    const keep = record.apiKeyCipher === undefined && !cli;
    const row = {
      id: existing?.id ?? id("preset"),
      ownerId: existing ? existing.ownerId : (record.ownerId ?? null),
      column: existing ? existing.column : (record.column ?? null),
      name: record.name,
      provider: record.provider,
      model: record.model,
      prompt: record.prompt,
      apiKeyCipher: cli ? null : keep ? (existing?.apiKeyCipher ?? null) : record.apiKeyCipher!,
      keyHint: cli ? null : keep ? (existing?.keyHint ?? null) : (record.apiKeyHint ?? null),
      secretName: cli
        ? record.secretName === undefined
          ? (existing?.secretName ?? null)
          : record.secretName
        : null,
      hasKey: false,
      // A new key is likely a new account, with its own usage.
      limitedUntil: keep ? (existing?.limitedUntil ?? null) : null,
      limitNote: keep ? (existing?.limitNote ?? null) : null,
      tokenAllowance: existing?.tokenAllowance ?? null,
      tokenAllowanceWindowDays: existing?.tokenAllowanceWindowDays ?? DEFAULT_ALLOWANCE_WINDOW_DAYS,
    };
    row.hasKey = row.apiKeyCipher !== null;
    s.presets.set(row.id, row);
    return publicPreset(row);
  }

  async setPresetLimit(presetId: string, limit: { until: Date; note: string } | null): Promise<void> {
    const row = store().presets.get(presetId);
    if (!row) return;
    row.limitedUntil = limit ? limit.until.toISOString() : null;
    row.limitNote = limit ? limit.note : null;
  }

  async deletePreset(presetId: string): Promise<void> {
    const s = store();
    s.presets.delete(presetId);
    for (const [k, v] of s.columnAgents) {
      if (v !== presetId) continue;
      s.columnAgents.delete(k);
      s.columnOverrides.delete(k);
    }
  }

  async setPresetAllowance(
    presetId: string,
    allowance: { tokens: number | null; windowDays: number | null },
  ): Promise<void> {
    const row = store().presets.get(presetId);
    if (!row) return;
    row.tokenAllowance = allowance.tokens;
    row.tokenAllowanceWindowDays = allowance.windowDays ?? DEFAULT_ALLOWANCE_WINDOW_DAYS;
  }

  async columnOverrides(projectId: string): Promise<ColumnOverrides> {
    const out: ColumnOverrides = {};
    for (const [k, v] of store().columnOverrides) {
      const [p, column] = k.split(":");
      if (p === projectId) out[column as ColumnId] = { ...v };
    }
    return out;
  }

  async setColumnOverride(projectId: string, column: ColumnId, override: ColumnOverride): Promise<boolean> {
    const s = store();
    const key = `${projectId}:${column}`;
    if (!s.columnAgents.has(key)) return false;
    s.columnOverrides.set(key, { ...override });
    return true;
  }

  async columnAgents(projectId: string): Promise<ColumnAgents> {
    const out: ColumnAgents = {};
    for (const [k, v] of store().columnAgents) {
      const [p, column] = k.split(":");
      // The assistant's preset shares this map but is not a column.
      if (p === projectId && column !== "assistant") out[column as ColumnId] = v;
    }
    return out;
  }

  async setColumnAgent(
    projectId: string,
    column: ColumnId,
    presetId: string | null,
  ): Promise<void> {
    const s = store();
    if (presetId === null) {
      s.columnAgents.delete(`${projectId}:${column}`);
      s.columnOverrides.delete(`${projectId}:${column}`);
    } else s.columnAgents.set(`${projectId}:${column}`, presetId);
  }

  async assistantAgent(projectId: string): Promise<string | null> {
    return store().columnAgents.get(`${projectId}:assistant`) ?? null;
  }

  async setAssistantAgent(projectId: string, presetId: string | null): Promise<void> {
    const s = store();
    if (presetId === null) s.columnAgents.delete(`${projectId}:assistant`);
    else s.columnAgents.set(`${projectId}:assistant`, presetId);
  }

  async setScoutAgent(projectId: string, presetId: string | null): Promise<void> {
    const project = store().projects.get(projectId);
    if (project) project.scoutPresetId = presetId;
  }

  async setAutoEscalate(projectId: string, autoEscalate: boolean): Promise<void> {
    const project = store().projects.get(projectId);
    if (project) project.autoEscalate = autoEscalate;
  }

  async markTicketAutoEscalated(ticketId: string): Promise<void> {
    const extras = store().ticketExtras.get(ticketId);
    if (extras && !extras.autoEscalatedAt) {
      extras.autoEscalatedAt = new Date().toISOString();
      await this.recordTicketChange(ticketId, { kind: "points", detail: { autoEscalated: true } });
    }
  }

  async setColony(
    projectId: string,
    colony: { colonySize: number | null; colonyReserve: number; autoScout: boolean },
  ): Promise<void> {
    const project = store().projects.get(projectId);
    if (project) Object.assign(project, colony);
  }

  async setAutoMerge(projectId: string, autoMerge: boolean): Promise<void> {
    const project = store().projects.get(projectId);
    if (project) project.autoMerge = autoMerge;
  }

  async assistantMessages(projectId: string): Promise<AssistantMessage[]> {
    return store().assistant.filter((m) => m.projectId === projectId).map((m) => ({ ...m }));
  }

  async assistantMessage(id: string): Promise<AssistantMessage | null> {
    const found = store().assistant.find((m) => m.id === id);
    return found ? { ...found } : null;
  }

  async addAssistantMessage(input: {
    projectId: string;
    role: "user" | "assistant";
    content: string;
    status?: AssistantMessage["status"];
  }): Promise<AssistantMessage> {
    const message: AssistantMessage = {
      id: `msg_${Math.random().toString(36).slice(2, 10)}`,
      proposals: [],
      runnerJob: null,
      runnerAgent: null,
      createdAt: new Date(),
      ...input,
      status: input.status ?? "done",
    };
    store().assistant.push(message);
    return { ...message };
  }

  async updateAssistantMessage(
    id: string,
    update: Partial<Pick<AssistantMessage, "content" | "proposals" | "status" | "runnerJob">>,
  ): Promise<void> {
    const found = store().assistant.find((m) => m.id === id);
    if (found) Object.assign(found, update);
  }

  async clearAssistant(projectId: string): Promise<void> {
    const s = store();
    s.assistant = s.assistant.filter((m) => m.projectId !== projectId);
  }

  async cardChatMessages(cardId: string): Promise<CardChatMessage[]> {
    return store()
      .cardChat.filter((m) => m.cardId === cardId)
      .map((m) => ({ ...m }));
  }

  async cardChatMessage(id: string): Promise<CardChatMessage | null> {
    const found = store().cardChat.find((m) => m.id === id);
    return found ? { ...found } : null;
  }

  async addCardChatMessage(input: {
    projectId: string;
    cardKind: "epic" | "ticket";
    cardId: string;
    role: "user" | "assistant";
    content: string;
    status?: CardChatMessage["status"];
  }): Promise<CardChatMessage> {
    const message: CardChatMessage = {
      id: `cchat_${Math.random().toString(36).slice(2, 10)}`,
      runnerJob: null,
      agentPresetId: null,
      // An answer made here writes its own counters when it lands.
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
      createdAt: new Date(),
      ...input,
      status: input.status ?? "done",
    };
    store().cardChat.push(message);
    return { ...message };
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
    const found = store().cardChat.find((m) => m.id === id);
    if (found) Object.assign(found, update);
  }

  async clearCardChat(cardId: string): Promise<void> {
    const s = store();
    s.cardChat = s.cardChat.filter((m) => m.cardId !== cardId);
  }

  async pendingCardChatJobs(projectId: string): Promise<CardChatMessage[]> {
    return store()
      .cardChat.filter((m) => m.projectId === projectId && m.status === "pending" && !!m.runnerJob)
      .map((m) => ({ ...m }));
  }

  async orphanedCardChats(projectId: string, olderThan: Date): Promise<CardChatMessage[]> {
    return store()
      .cardChat.filter(
        (m) => m.projectId === projectId && m.status === "pending" && !m.runnerJob && m.createdAt < olderThan,
      )
      .map((m) => ({ ...m }));
  }

  async orphanedAssistantAnswers(projectId: string, olderThan: Date): Promise<AssistantMessage[]> {
    return store()
      .assistant.filter(
        (m) =>
          m.projectId === projectId &&
          m.role === "assistant" &&
          m.status === "pending" &&
          !m.runnerJob &&
          m.createdAt < olderThan,
      )
      .map((m) => ({ ...m }));
  }

  async rebalanceColumn(projectId: string, column: ColumnId): Promise<void> {
    const cards = (await this.boardCards(projectId))
      .filter((c) => columnOf(c) === column)
      .sort(byPosition);
    if (!needsRebalance(cards.map((c) => c.position))) return;
    const fresh = rebalance(cards.length);
    cards.forEach((card, i) => {
      card.position = fresh[i]!;
    });
  }
}

function toDetail(
  card: BoardCard,
  extras: TicketExtras | undefined,
  projectId: string,
): TicketDetail {
  return {
    id: card.id,
    epicId: card.epicId ?? "",
    projectId,
    key: card.key,
    title: card.title,
    description: extras?.description ?? card.title,
    acceptanceCriteria: extras?.acceptanceCriteria ?? [],
    fileScope: card.fileScope,
    scopeRequest: extras?.scopeRequest ?? [],
    status: card.status,
    stalledIn: card.stalledIn,
    stage: card.stage,
    branchName: extras?.branchName ?? null,
    prNumber: card.prNumber,
    prUrl: card.prUrl,
    blockedReason: card.blockedReason,
    attempts: extras?.attempts ?? 0,
    summary: extras?.summary ?? null,
    runnerJob: extras?.runnerJob ?? null,
    runnerAgent: extras?.runnerAgent ?? null,
    issueNumber: extras?.issueNumber ?? null,
    sourceIssueNumber: extras?.sourceIssueNumber ?? null,
    storyPoints: card.storyPoints ?? null,
    plan: extras?.plan ?? [],
    handoff: extras?.handoff ?? [],
    followUps: extras?.followUps ?? [],
    reviewedSha: extras?.reviewedSha ?? null,
    reviewedHead: extras?.reviewedHead ?? null,
    stackedOn: extras?.stackedOn ?? null,
    autoEscalatedAt: extras?.autoEscalatedAt ?? null,
    needsHuman: card.needsHuman ?? null,
    workType: card.workType ?? null,
    bugSeverity: card.bugSeverity ?? null,
    scoutOf: extras?.scoutOf ?? null,
    scoutBrief: extras?.scoutBrief ?? null,
    scoutPresetId: extras?.scoutPresetId ?? null,
    scouts: card.scouts ?? 0,
    scoutPick: card.scoutPick ?? null,
    scoutWhy: extras?.scoutWhy ?? null,
  };
}

function isScout(s: Store, card: BoardCard): boolean {
  return card.kind === "ticket" && !!s.ticketExtras.get(card.id)?.scoutOf;
}

function matchesAttachmentRef(row: AttachmentRow, ref: AttachmentRef): boolean {
  if ("epicId" in ref) return row.epicId === ref.epicId;
  if ("ticketId" in ref) return row.ticketId === ref.ticketId;
  return row.requestId === ref.requestId;
}

function toAttachmentSummary(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    kind: row.kind,
    size: row.size,
    url: `/api/attachments/${row.id}`,
  };
}

function publicPreset(row: AgentPreset & { apiKeyCipher: string | null }): AgentPreset {
  const { apiKeyCipher, ...rest } = row;
  return { ...rest, hasKey: apiKeyCipher !== null };
}

function inScope(ownerId: string | null, scope: OwnerScope): boolean {
  return ownerId === scope.ownerId || (scope.includeUnowned && ownerId === null);
}
