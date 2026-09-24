import "server-only";

import { normalizeRepo } from "@/lib/secrets/repo";

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
  CardChatMessage,
} from "./repository";
import type {
  AgentPreset,
  AgentRunStatus,
  AttachmentSummary,
  BoardCard,
  ColumnAgents,
  PlanStep,
} from "@/lib/domain/entities";
import { type ColumnId, columnOf } from "@/lib/domain/status";
import { byPosition, needsRebalance, rebalance } from "@/lib/ordering";
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
  plan?: PlanStep[];
  handoff?: string[];
  reviewedSha?: string | null;
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
  /** The project the demo board belongs to, and the fallback. */
  project: ProjectSummary;
  projects: Map<string, ProjectSummary>;
  /** Epic id to project id. Tickets belong to their epic's project. */
  epicProject: Map<string, string>;
  cards: Map<string, BoardCard>;
  ticketExtras: Map<string, TicketExtras>;
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
  events: Array<{
    seq: number;
    projectId: string;
    type: string;
    payload: unknown;
    at: Date;
  }>;
  runs: Map<
    string,
    RunRecord & { status: AgentRunStatus; startedAt: Date; costCents: number; error: string | null }
  >;
  deliveries: Set<string>;
  presets: Map<string, AgentPreset & { apiKeyCipher: string | null }>;
  users: Map<string, UserRecord>;
  /** `${projectId}:${column}` to preset id. */
  columnAgents: Map<string, string>;
  assistant: AssistantMessage[];
  cardChat: CardChatMessage[];
  attachments: Map<string, AttachmentRow>;
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
    existing.users ??= new Map();
    existing.epicNumbers ??= new Map();
    existing.prdTimes ??= new Map();
    existing.epicJobTimes ??= new Map();
    existing.epicJobAgents ??= new Map();
    existing.attachments ??= new Map();
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
    prdTimes: new Map(),
    rawRequests: new Map(),
    showcases: new Map(),
    epicJobs: new Map(),
    epicJobAgents: new Map(),
    epicJobTimes: new Map(),
    epicIssues: new Map(),
    epicNumbers: new Map(),
    events: [],
    runs: new Map(),
    deliveries: new Set(),
    presets: new Map(),
    users: new Map(),
    columnAgents: new Map(),
    assistant: [],
    cardChat: [],
    attachments: new Map(),
  };
  globalThis.__formicMemoryStore = s;
  return s;
}

/** The project a card belongs to. Seeded cards belong to the default one. */
function projectOf(s: Store, card: BoardCard): string {
  const epicId = card.kind === "epic" ? card.id : card.epicId;
  return (epicId && s.epicProject.get(epicId)) || s.project.id;
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
    // Runs still going here, by the card they are for.
    const live = new Map<string, { role: BoardCard["agentRole"]; since: Date }>();
    for (const run of s.runs.values()) {
      if (run.status !== "running" && run.status !== "queued") continue;
      const id = run.ticketId ?? run.epicId;
      if (id) live.set(id, { role: run.role, since: run.startedAt });
    }
    for (const card of cards) {
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
                role: card.status === "review" ? ("reviewer" as const) : ("coder" as const),
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
      const children = cards.filter((c) => c.epicId === card.id);
      card.childCount = children.length;
      card.doneCount = children.filter((c) => c.status === "merged").length;
    }
    // A standalone Epic is a holder, not its own card: its child ticket
    // renders alone, detached, exactly as today.
    return cards.filter((c) => !(c.kind === "epic" && c.standalone)).sort(byPosition);
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
        storyPoints: input.storyPoints ?? null,
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
    if (card.status !== input.status) {
      card.updatedAt = new Date().toISOString();
      if (input.status === "running" && !card.startedAt) card.startedAt = card.updatedAt;
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
      size: input.size,
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
      prdUpdatedAt: s.prdTimes.get(epicId) ?? null,
      runnerJob: s.epicJobs.get(epicId) ?? null,
      runnerAgent: s.epicJobAgents.get(epicId) ?? null,
      issueNumber: s.epicIssues.get(epicId) ?? null,
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
      s.ticketExtras.delete(id);
    }
    for (const card of s.cards.values()) {
      card.dependsOn = card.dependsOn.filter((id) => s.cards.has(id));
    }
    for (const [runId, run] of s.runs) {
      if (run.ticketId && !s.cards.has(run.ticketId)) s.runs.delete(runId);
    }
  }

  async deleteEpic(epicId: string): Promise<void> {
    const s = store();
    for (const card of [...s.cards.values()]) {
      if (card.epicId !== epicId) continue;
      s.cards.delete(card.id);
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

    if (update.status !== undefined && update.status !== card.status) {
      card.updatedAt = new Date().toISOString();
      if (update.status === "running" && !card.startedAt) card.startedAt = card.updatedAt;
    }
    // The first move to merged is scored against the project's heat then.
    if (update.status === "merged" && !card.mergedAt) {
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
    if (update.runnerJob !== undefined) {
      extras.runnerJob = update.runnerJob;
      extras.runnerJobAt = update.runnerJob ? new Date() : null;
    }
    if (update.runnerAgent !== undefined) extras.runnerAgent = update.runnerAgent;
    if (update.issueNumber !== undefined) extras.issueNumber = update.issueNumber;
    if (update.plan !== undefined) extras.plan = update.plan;
    if (update.handoff !== undefined) extras.handoff = update.handoff;
    if (update.reviewedSha !== undefined) extras.reviewedSha = update.reviewedSha;
  }

  async ticketsForEpic(epicId: string): Promise<TicketDetail[]> {
    const s = store();
    return [...s.cards.values()]
      .filter((c) => c.kind === "ticket" && c.epicId === epicId)
      .sort(byPosition)
      .map((c) => toDetail(c, s.ticketExtras.get(c.id), projectOf(s, c)));
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
    });
  }

  async finishRun(runId: string, outcome: RunOutcome): Promise<void> {
    const run = store().runs.get(runId);
    if (run) {
      run.status = outcome.status;
      run.error = outcome.error;
      run.costCents = outcome.costCents;
    }
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
      run.error = reason;
      cancelled.push({ id: run.id, sandboxId: run.sandboxId });
    }
    return cancelled;
  }

  async runCancelReason(runId: string): Promise<string | null> {
    const run = store().runs.get(runId);
    return run && run.status === "cancelled" ? (run.error ?? "Stopped.") : null;
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
      provider: record.provider,
      model: record.model,
      prompt: record.prompt,
      apiKeyCipher: keep ? (existing?.apiKeyCipher ?? null) : record.apiKeyCipher!,
      keyHint: keep ? (existing?.keyHint ?? null) : (record.apiKeyHint ?? null),
      hasKey: false,
      // A new key is likely a new account, with its own usage.
      limitedUntil: keep ? (existing?.limitedUntil ?? null) : null,
      limitNote: keep ? (existing?.limitNote ?? null) : null,
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

  async assistantAgent(projectId: string): Promise<string | null> {
    return store().columnAgents.get(`${projectId}:assistant`) ?? null;
  }

  async setAssistantAgent(projectId: string, presetId: string | null): Promise<void> {
    const s = store();
    if (presetId === null) s.columnAgents.delete(`${projectId}:assistant`);
    else s.columnAgents.set(`${projectId}:assistant`, presetId);
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
      createdAt: new Date(),
      ...input,
      status: input.status ?? "done",
    };
    store().cardChat.push(message);
    return { ...message };
  }

  async updateCardChatMessage(
    id: string,
    update: Partial<Pick<CardChatMessage, "content" | "status" | "runnerJob">>,
  ): Promise<void> {
    const found = store().cardChat.find((m) => m.id === id);
    if (found) Object.assign(found, update);
  }

  async clearCardChat(cardId: string): Promise<void> {
    const s = store();
    s.cardChat = s.cardChat.filter((m) => m.cardId !== cardId);
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
    storyPoints: card.storyPoints ?? null,
    plan: extras?.plan ?? [],
    handoff: extras?.handoff ?? [],
    reviewedSha: extras?.reviewedSha ?? null,
  };
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
