import "server-only";

import { normalizeRepo } from "@/lib/secrets/repo";

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
} from "./repository";
import type {
  AgentPreset,
  AgentRunStatus,
  BoardCard,
  ColumnAgents,
} from "@/lib/domain/entities";
import { type ColumnId, columnFor } from "@/lib/domain/status";
import { byPosition, needsRebalance, rebalance } from "@/lib/ordering";
import { normalizeScope } from "@/lib/domain/scope";

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
}

interface Store {
  /** The project the demo board belongs to, and the fallback. */
  project: ProjectSummary;
  projects: Map<string, ProjectSummary>;
  /** Epic id to project id. Tickets belong to their epic's project. */
  epicProject: Map<string, string>;
  cards: Map<string, BoardCard>;
  ticketExtras: Map<string, TicketExtras>;
  prds: Map<string, unknown>;
  rawRequests: Map<string, string>;
  showcases: Map<string, string>;
  events: Array<{
    seq: number;
    projectId: string;
    type: string;
    payload: unknown;
    at: Date;
  }>;
  runs: Map<string, RunRecord & { status: AgentRunStatus; startedAt: Date }>;
  deliveries: Set<string>;
  presets: Map<string, AgentPreset & { apiKeyCipher: string | null }>;
  users: Map<string, UserRecord>;
  /** `${projectId}:${column}` to preset id. */
  columnAgents: Map<string, string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __formicMemoryStore: Store | undefined;
}

function store(): Store {
  const existing = globalThis.__formicMemoryStore;
  if (existing) {
    // A store from before presets existed survives a dev-server reload.
    existing.presets ??= new Map();
    existing.columnAgents ??= new Map();
    existing.users ??= new Map();
    return existing;
  }
  const project: ProjectSummary = {
    id: "project_default",
    ownerId: null,
    name: "Formic",
    repoFullName: normalizeRepo(process.env.GITHUB_REPO) ?? "Ghigog/Formic",
    baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
  };
  const s: Store = {
    project,
    projects: new Map([[project.id, project]]),
    epicProject: new Map(),
    cards: new Map(),
    ticketExtras: new Map(),
    prds: new Map(),
    rawRequests: new Map(),
    showcases: new Map(),
    events: [],
    runs: new Map(),
    deliveries: new Set(),
    presets: new Map(),
    users: new Map(),
    columnAgents: new Map(),
  };
  globalThis.__formicMemoryStore = s;
  return s;
}

/** The project a card belongs to. Seeded cards belong to the default one. */
function projectOf(s: Store, card: BoardCard): string {
  const epicId = card.kind === "epic" ? card.id : card.epicId;
  return (epicId && s.epicProject.get(epicId)) || s.project.id;
}

export function seedMemory(cards: BoardCard[]): void {
  const s = store();
  if (s.cards.size > 0) return;
  for (const card of cards) s.cards.set(card.id, { ...card });
}

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

  async countUsers(): Promise<number> {
    return store().users.size;
  }

  async adoptUnowned(userId: string): Promise<void> {
    const s = store();
    for (const p of s.projects.values()) if (p.ownerId === null) p.ownerId = userId;
    for (const p of s.presets.values()) if (p.ownerId === null) p.ownerId = userId;
  }

  async projectById(projectId: string): Promise<ProjectSummary | null> {
    return store().projects.get(projectId) ?? null;
  }

  async ensureProject(input: {
    ownerId: string | null;
    repoFullName: string;
    baseBranch: string;
  }): Promise<ProjectSummary> {
    const s = store();
    const found = [...s.projects.values()].find(
      (p) =>
        p.ownerId === input.ownerId &&
        p.repoFullName.toLowerCase() === input.repoFullName.toLowerCase(),
    );
    if (found) return found;
    const project: ProjectSummary = {
      id: id("project"),
      ownerId: input.ownerId,
      name: input.repoFullName.split("/")[1] ?? input.repoFullName,
      repoFullName: input.repoFullName,
      baseBranch: input.baseBranch,
    };
    s.projects.set(project.id, project);
    return project;
  }

  async projectOfCard(cardId: string): Promise<string | null> {
    const s = store();
    const card = s.cards.get(cardId);
    return card ? projectOf(s, card) : null;
  }

  async boardCards(projectId?: string): Promise<BoardCard[]> {
    const s = store();
    const cards = [...s.cards.values()].filter(
      (c) => projectId === undefined || projectOf(s, c) === projectId,
    );
    for (const card of cards) {
      if (card.kind !== "epic") continue;
      const children = cards.filter((c) => c.epicId === card.id);
      card.childCount = children.length;
      card.doneCount = children.filter((c) => c.status === "merged").length;
    }
    return cards.sort(byPosition);
  }

  async createEpic(input: CreateEpicInput): Promise<BoardCard> {
    const s = store();
    const n =
      (await this.boardCards(input.projectId)).filter((c) => c.kind === "epic")
        .length + 1;
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
    s.cards.set(card.id, card);
    s.epicProject.set(card.id, input.projectId);
    s.rawRequests.set(card.id, input.rawRequest);
    return card;
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
        size: input.size,
        agentRole: null,
        model: null,
        fileScope: normalizeScope(input.fileScope),
        dependsOn: [],
        prNumber: null,
        prUrl: null,
        blockedReason: null,
        costCents: 0,
        childCount: 0,
        doneCount: 0,
      };
      made.set(input.key, card);
      s.ticketExtras.set(card.id, {
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
        branchName: null,
        attempts: 0,
        summary: null,
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
    card.status = input.status;
    card.stalledIn = input.stalledIn;
    card.position = input.position;
    if (input.detached !== undefined) card.detached = input.detached;
  }

  async columnPositions(projectId: string, column: ColumnId): Promise<number[]> {
    return (await this.boardCards(projectId))
      .filter((c) => columnFor(c.status, c.stalledIn) === column)
      .map((c) => c.position)
      .sort((a, b) => a - b);
  }

  async cardById(cardId: string): Promise<BoardCard | null> {
    return store().cards.get(cardId) ?? null;
  }

  async epicDetail(epicId: string) {
    const s = store();
    const card = s.cards.get(epicId);
    if (!card) return null;
    return {
      title: card.title,
      rawRequest: s.rawRequests.get(epicId) ?? card.title,
      prd: s.prds.get(epicId) ?? null,
    };
  }

  async setEpicPrd(epicId: string, prd: unknown): Promise<void> {
    const s = store();
    s.prds.set(epicId, prd);
    const card = s.cards.get(epicId);
    if (card) {
      card.status = "specified";
      card.stage = 2;
    }
  }

  async setEpicShowcase(epicId: string, markdown: string): Promise<void> {
    const s = store();
    s.showcases.set(epicId, markdown);
    const card = s.cards.get(epicId);
    if (card) card.stage = 8;
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

  async latestEventSeq(projectId: string): Promise<number> {
    const mine = store().events.filter((e) => e.projectId === projectId);
    return mine.at(-1)?.seq ?? 0;
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

    if (update.status !== undefined) card.status = update.status;
    // A merged ticket joins its epic's group in Done, wherever it sat.
    if (update.status === "merged") card.detached = false;
    if (update.stalledIn !== undefined) card.stalledIn = update.stalledIn;
    if (update.stage !== undefined) card.stage = update.stage;
    if (update.prNumber !== undefined) card.prNumber = update.prNumber;
    if (update.prUrl !== undefined) card.prUrl = update.prUrl;
    if (update.blockedReason !== undefined) {
      card.blockedReason = update.blockedReason;
    }
    if (update.costCents !== undefined) card.costCents += update.costCents;

    const extras = s.ticketExtras.get(ticketId);
    if (!extras) return;
    if (update.branchName !== undefined) extras.branchName = update.branchName;
    if (update.attempts !== undefined) extras.attempts = update.attempts;
    if (update.summary !== undefined) extras.summary = update.summary;
  }

  async ticketsForEpic(epicId: string): Promise<TicketDetail[]> {
    const s = store();
    return [...s.cards.values()]
      .filter((c) => c.kind === "ticket" && c.epicId === epicId)
      .sort(byPosition)
      .map((c) => toDetail(c, s.ticketExtras.get(c.id), projectOf(s, c)));
  }

  async startRun(run: RunRecord): Promise<void> {
    store().runs.set(run.id, { ...run, status: "running", startedAt: new Date() });
  }

  async finishRun(runId: string, outcome: RunOutcome): Promise<void> {
    const run = store().runs.get(runId);
    if (run) run.status = outcome.status;
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
    const keep = record.apiKeyCipher === undefined;
    const row = {
      id: existing?.id ?? id("preset"),
      ownerId: existing ? existing.ownerId : (record.ownerId ?? null),
      name: record.name,
      provider: "anthropic" as const,
      model: record.model,
      prompt: record.prompt,
      apiKeyCipher: keep ? (existing?.apiKeyCipher ?? null) : record.apiKeyCipher!,
      keyHint: keep ? (existing?.keyHint ?? null) : (record.apiKeyHint ?? null),
      hasKey: false,
    };
    row.hasKey = row.apiKeyCipher !== null;
    s.presets.set(row.id, row);
    return publicPreset(row);
  }

  async deletePreset(presetId: string): Promise<void> {
    const s = store();
    s.presets.delete(presetId);
    for (const [k, v] of s.columnAgents) if (v === presetId) s.columnAgents.delete(k);
  }

  async columnAgents(projectId: string): Promise<ColumnAgents> {
    const out: ColumnAgents = {};
    for (const [k, v] of store().columnAgents) {
      const [p, column] = k.split(":");
      if (p === projectId) out[column as ColumnId] = v;
    }
    return out;
  }

  async setColumnAgent(
    projectId: string,
    column: ColumnId,
    presetId: string | null,
  ): Promise<void> {
    const s = store();
    if (presetId === null) s.columnAgents.delete(`${projectId}:${column}`);
    else s.columnAgents.set(`${projectId}:${column}`, presetId);
  }

  async rebalanceColumn(projectId: string, column: ColumnId): Promise<void> {
    const cards = (await this.boardCards(projectId))
      .filter((c) => columnFor(c.status, c.stalledIn) === column)
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
    status: card.status,
    stalledIn: card.stalledIn,
    stage: card.stage,
    branchName: extras?.branchName ?? null,
    prNumber: card.prNumber,
    prUrl: card.prUrl,
    blockedReason: card.blockedReason,
    attempts: extras?.attempts ?? 0,
    summary: extras?.summary ?? null,
  };
}

function publicPreset(row: AgentPreset & { apiKeyCipher: string | null }): AgentPreset {
  const { apiKeyCipher, ...rest } = row;
  return { ...rest, hasKey: apiKeyCipher !== null };
}

function inScope(ownerId: string | null, scope: OwnerScope): boolean {
  return ownerId === scope.ownerId || (scope.includeUnowned && ownerId === null);
}
