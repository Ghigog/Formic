import "server-only";

import type {
  AgentPreset,
  AgentRole,
  AgentRunStatus,
  BoardCard,
  ColumnAgents,
} from "@/lib/domain/entities";
import type { ColumnId, TicketStatus } from "@/lib/domain/status";
import type { ProviderId } from "@/lib/llm/providers";

/**
 * The data boundary. Two implementations: Prisma against Postgres, and an
 * in-memory store used when DATABASE_URL is unset so the app runs with no
 * infrastructure. Everything above this interface is storage-agnostic.
 */

export interface CreateEpicInput {
  projectId: string;
  title: string;
  rawRequest: string;
  position: number;
}

export interface CreateTicketInput {
  epicId: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  size: "S" | "M" | "L" | "XL";
  position: number;
  dependsOnKeys: string[];
}

export interface MoveInput {
  cardId: string;
  kind: "epic" | "ticket";
  status: TicketStatus;
  stalledIn: ColumnId | null;
  position: number;
  /** Tickets only. Omitted leaves it as it was. */
  detached?: boolean;
}

/** Everything a coding agent and its pipeline need about one ticket. */
export interface TicketDetail {
  id: string;
  epicId: string;
  projectId: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  status: TicketStatus;
  stalledIn: ColumnId | null;
  stage: number;
  branchName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  blockedReason: string | null;
  attempts: number;
  summary: string | null;
  /** The cloud runner job this ticket is waiting on, if any. */
  runnerJob: string | null;
}

export interface TicketUpdate {
  status?: TicketStatus;
  stalledIn?: ColumnId | null;
  stage?: number;
  branchName?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  blockedReason?: string | null;
  attempts?: number;
  summary?: string | null;
  runnerJob?: string | null;
  costCents?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface RunRecord {
  id: string;
  role: AgentRole;
  epicId: string | null;
  ticketId: string | null;
  model: string | null;
  sandboxId: string | null;
}

export interface RunOutcome {
  status: AgentRunStatus;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

export interface ProjectSummary {
  id: string;
  /** Null for the demo board, which belongs to no one. */
  ownerId: string | null;
  name: string;
  repoFullName: string;
  baseBranch: string;
}

/** Whose projects and presets a query sees. */
export interface OwnerScope {
  ownerId: string;
  /** Also the unowned ones: the demo board, and anything from before accounts. */
  includeUnowned: boolean;
}

/** A person, with their credentials still sealed. */
export interface UserRecord {
  id: string;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  githubTokenCipher: string | null;
  githubTokenExpiresAt: Date | null;
  githubRefreshCipher: string | null;
  githubRefreshExpiresAt: Date | null;
  e2bKeyCipher: string | null;
  e2bKeyHint: string | null;
  anthropicKeyCipher: string | null;
  anthropicKeyHint: string | null;
}

export type UserSecrets = Partial<
  Pick<
    UserRecord,
    | "githubTokenCipher"
    | "githubTokenExpiresAt"
    | "githubRefreshCipher"
    | "githubRefreshExpiresAt"
    | "e2bKeyCipher"
    | "e2bKeyHint"
    | "anthropicKeyCipher"
    | "anthropicKeyHint"
  >
>;

export interface GithubProfile {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** A preset as stored. The key arrives here already sealed. */
export interface PresetRecord {
  id?: string;
  /** Set on create; an update keeps the owner it had. */
  ownerId?: string | null;
  provider: ProviderId;
  name: string;
  model: string;
  prompt: string;
  /** Sealed key; null clears it; omitted keeps it. */
  apiKeyCipher?: string | null;
  apiKeyHint?: string | null;
}

export interface Repository {
  /** The demo board: the first unowned project, created on demand. */
  defaultProject(): Promise<ProjectSummary>;
  listProjects(scope: OwnerScope): Promise<ProjectSummary[]>;
  /** Every project on a repository, whoever owns it. For webhooks. */
  projectsForRepo(repoFullName: string): Promise<ProjectSummary[]>;
  projectById(projectId: string): Promise<ProjectSummary | null>;
  /** Someone's project for a repository, created the first time they pick it. */
  ensureProject(input: {
    ownerId: string | null;
    repoFullName: string;
    baseBranch: string;
  }): Promise<ProjectSummary>;

  /* People. */

  userById(userId: string): Promise<UserRecord | null>;
  /** Creates or refreshes someone from their GitHub profile. */
  upsertUser(profile: GithubProfile): Promise<UserRecord>;
  updateUser(userId: string, secrets: UserSecrets): Promise<UserRecord>;
  countUsers(): Promise<number>;
  /** Gives a user every unowned project and preset. */
  adoptUnowned(userId: string): Promise<void>;
  /** Which project an epic or ticket belongs to. */
  projectOfCard(cardId: string): Promise<string | null>;
  boardCards(projectId: string): Promise<BoardCard[]>;
  createEpic(input: CreateEpicInput): Promise<BoardCard>;
  createTickets(input: CreateTicketInput[]): Promise<BoardCard[]>;
  move(input: MoveInput): Promise<void>;
  /** Positions in a column, ascending, for fractional index placement. */
  columnPositions(projectId: string, column: ColumnId): Promise<number[]>;
  cardById(id: string): Promise<BoardCard | null>;
  epicDetail(
    epicId: string,
  ): Promise<{ title: string; rawRequest: string; prd: unknown; runnerJob: string | null } | null>;
  /** The Actions run a CLI agent is doing for this epic, or null. */
  setEpicRunnerJob(epicId: string, job: string | null): Promise<void>;
  setEpicPrd(epicId: string, prd: unknown, byHuman: boolean): Promise<void>;
  setEpicShowcase(epicId: string, markdown: string): Promise<void>;
  appendEvent(projectId: string, type: string, payload: unknown): Promise<number>;
  eventsAfter(
    projectId: string,
    seq: number,
    limit?: number,
  ): Promise<Array<{ seq: number; type: string; payload: unknown; at: Date }>>;
  /** Highest event sequence number so far, or 0 with none. */
  latestEventSeq(projectId: string): Promise<number>;
  rebalanceColumn(projectId: string, column: ColumnId): Promise<void>;

  /* PROT-06 / PROT-07: the ticket run lifecycle. */

  ticketDetail(ticketId: string): Promise<TicketDetail | null>;
  /** The ticket a webhook is about. Pull request numbers are unique per repo. */
  ticketByPrNumber(
    projectId: string,
    prNumber: number,
  ): Promise<TicketDetail | null>;
  updateTicket(ticketId: string, update: TicketUpdate): Promise<void>;
  /** Every ticket under an Epic, for dependency gating and the showcase. */
  ticketsForEpic(epicId: string): Promise<TicketDetail[]>;

  startRun(run: RunRecord): Promise<void>;
  finishRun(runId: string, outcome: RunOutcome): Promise<void>;
  /**
   * Runs still marked live that began before `startedBefore`. Callers pass a
   * cutoff older than any worker can live, so every match is an orphan.
   */
  unfinishedRuns(
    startedBefore: Date,
  ): Promise<Array<RunRecord & { status: AgentRunStatus }>>;

  /* Agent presets, and which one each column runs. */

  listPresets(scope: OwnerScope): Promise<AgentPreset[]>;
  /** A preset and its sealed key, for starting a run. */
  presetForRun(
    presetId: string,
  ): Promise<{ preset: AgentPreset; apiKeyCipher: string | null } | null>;
  savePreset(record: PresetRecord): Promise<AgentPreset>;
  /** Also unassigns it from every column it ran. */
  deletePreset(presetId: string): Promise<void>;
  columnAgents(projectId: string): Promise<ColumnAgents>;
  setColumnAgent(
    projectId: string,
    column: ColumnId,
    presetId: string | null,
  ): Promise<void>;

  /**
   * Records a webhook delivery, returning false when it has been seen before.
   * GitHub delivers at least once and out of order; this is what makes a
   * redelivery a no-op rather than a second fix commit.
   */
  claimDelivery(key: string): Promise<boolean>;
}
