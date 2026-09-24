import "server-only";

import type {
  AgentPreset,
  AgentRole,
  AgentRunStatus,
  AttachmentKind,
  AttachmentSummary,
  BoardCard,
  ColumnAgents,
  PlanStep,
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
  storyPoints?: number | null;
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
  /**
   * Dropped somewhere it cannot work: that column, and what is wrong. The
   * status above is then what is still true of it. Omitted clears it.
   */
  misplaced?: { in: ColumnId; reason: string } | null;
}

/** Where a request was rerouted from, and why. Null clears it. */
export interface Reroute {
  from: ColumnId;
  reason: string;
}

export interface CreateAttachmentInput {
  projectId: string;
  /** Exactly one of these three should be set. */
  epicId?: string | null;
  ticketId?: string | null;
  requestId?: string | null;
  filename: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  bytes: Uint8Array;
}

/** What attachmentsFor and claimAttachments scope by. */
export type AttachmentRef =
  | { epicId: string }
  | { ticketId: string }
  | { requestId: string };

export interface AttachmentContent {
  bytes: Uint8Array;
  mimeType: string;
}

/** One message in a board's assistant conversation. */
export interface AssistantMessage {
  id: string;
  projectId: string;
  role: "user" | "assistant";
  content: string;
  /** What the assistant proposed changing; each needs the person's approval. */
  proposals: AssistantProposal[];
  status: "done" | "pending" | "failed";
  runnerJob: string | null;
  /** The preset that job was dispatched with, so a failure is blamed on it. */
  runnerAgent: string | null;
  createdAt: Date;
}

export interface AssistantProposal {
  /** One line for the person to approve or not. */
  summary: string;
  action: unknown;
  state: "proposed" | "applied" | "dismissed" | "failed";
  /** Why applying it failed, when it did. */
  error?: string;
}

/** One message in a card's chat with its column's agent. */
export interface CardChatMessage {
  id: string;
  projectId: string;
  cardKind: "epic" | "ticket";
  cardId: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "pending" | "failed";
  runnerJob: string | null;
  createdAt: Date;
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
  /** The preset that job was dispatched with, so a failure is blamed on it. */
  runnerAgent: string | null;
  /** The GitHub issue that tracks it, once created. */
  issueNumber: number | null;
  storyPoints: number | null;
  /** The plan the agent is working through, oldest step first. */
  plan: PlanStep[];
  /** Steps outside the repository the person has to take. */
  handoff: string[];
  /** The head commit the Reviewer Agent last approved or pushed. */
  reviewedSha: string | null;
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
  runnerAgent?: string | null;
  issueNumber?: number | null;
  plan?: PlanStep[];
  handoff?: string[];
  reviewedSha?: string | null;
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
  /** The terms/privacy version last agreed to, or null if never. */
  termsAcceptedVersion: string | null;
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
  /** Records that this person agreed to a version of the terms, now. */
  acceptTerms(userId: string, version: string): Promise<UserRecord>;
  countUsers(): Promise<number>;
  /** Gives a user every unowned project and preset. */
  adoptUnowned(userId: string): Promise<void>;
  /** Removes a person and everything they own: projects, presets, and all that cascades from those. */
  deleteUser(userId: string): Promise<void>;
  /** Which project an epic or ticket belongs to. */
  projectOfCard(cardId: string): Promise<string | null>;
  boardCards(projectId: string): Promise<BoardCard[]>;
  createEpic(input: CreateEpicInput): Promise<BoardCard>;
  createTickets(input: CreateTicketInput[]): Promise<BoardCard[]>;
  move(input: MoveInput): Promise<void>;
  /** Epics only: whether it is a holder with no card of its own. */
  setStandalone(epicId: string, standalone: boolean): Promise<void>;
  /** Where a card was rerouted from, and why. Null clears both fields. */
  setReroute(cardId: string, kind: "epic" | "ticket", reroute: Reroute | null): Promise<void>;
  createAttachment(input: CreateAttachmentInput): Promise<AttachmentSummary>;
  attachmentsFor(ref: AttachmentRef): Promise<AttachmentSummary[]>;
  /** The stored bytes and mime type, or null when no such attachment exists. */
  attachmentContent(id: string): Promise<AttachmentContent | null>;
  /** Moves every attachment under requestId to a real card, once it exists. */
  claimAttachments(
    requestId: string,
    ref: { epicId: string } | { ticketId: string },
  ): Promise<void>;
  deleteAttachments(ids: string[]): Promise<void>;
  /** Positions in a column, ascending, for fractional index placement. */
  columnPositions(projectId: string, column: ColumnId): Promise<number[]>;
  cardById(id: string): Promise<BoardCard | null>;
  epicDetail(
    epicId: string,
  ): Promise<{
    title: string;
    rawRequest: string;
    prd: unknown;
    /** When the PRD last changed, or null for none or from before this was kept. */
    prdUpdatedAt: Date | null;
    runnerJob: string | null;
    /** The preset that job was dispatched with, so a failure is blamed on it. */
    runnerAgent: string | null;
    issueNumber: number | null;
  } | null>;
  /** The GitHub issue that tracks this epic. */
  setEpicIssue(epicId: string, issueNumber: number): Promise<void>;
  /** The Actions run a CLI agent is doing for this epic, or null, and the preset dispatched with it. */
  setEpicRunnerJob(epicId: string, job: string | null, agentId?: string | null): Promise<void>;
  setEpicPrd(epicId: string, prd: unknown, byHuman: boolean): Promise<void>;
  setEpicShowcase(epicId: string, markdown: string): Promise<void>;
  /** Removes tickets, with their runs and dependencies both ways. */
  deleteTickets(ticketIds: string[]): Promise<void>;
  /** Removes an Epic with its tickets, runs and dependencies. */
  deleteEpic(epicId: string): Promise<void>;
  /** A planning stage stalled: the Epic stays in its column, with why. */
  stallEpic(
    epicId: string,
    stall: { status: "blocked" | "failed"; stalledIn: ColumnId; stage: number; reason: string },
  ): Promise<void>;
  appendEvent(projectId: string, type: string, payload: unknown): Promise<number>;
  eventsAfter(
    projectId: string,
    seq: number,
    limit?: number,
  ): Promise<Array<{ seq: number; type: string; payload: unknown; at: Date }>>;
  /**
   * What agents said and did on one ticket, oldest first: the events of the
   * given types whose payload names it. At most `limit`, the latest ones.
   */
  ticketEvents(
    projectId: string,
    ticketId: string,
    types: string[],
    limit?: number,
  ): Promise<Array<{ seq: number; type: string; payload: unknown; at: Date }>>;
  /** The same, but for events whose payload names an Epic. */
  epicEvents(
    projectId: string,
    epicId: string,
    types: string[],
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
  /**
   * Persists a run's running cost so it survives the process that is
   * driving it, and so an Epic's total can be summed from here instead of
   * from memory only one instance holds. Called as spend accrues, not only
   * once the run finishes.
   */
  recordRunSpend(runId: string, costCents: number): Promise<void>;
  /** Every run's spend under an Epic, finished or still running, summed. */
  epicSpentCents(epicId: string): Promise<number>;
  /**
   * Marks every run in scope that is still queued or running cancelled,
   * with a reason: the durable form of a stop, so a run driven by any
   * instance sees it on its next poll rather than only the one that
   * happened to receive the request. Returns which of them had a sandbox,
   * so the caller can dispose it.
   */
  cancelRuns(
    scope: { runId: string } | { epicId: string } | { projectId: string },
    reason: string,
  ): Promise<Array<{ id: string; sandboxId: string | null }>>;
  /** Why a run was cancelled, from this instance or another; null if it has not been. */
  runCancelReason(runId: string): Promise<string | null>;

  /* Agent presets, and which one each column runs. */

  listPresets(scope: OwnerScope): Promise<AgentPreset[]>;
  /** A preset and its sealed key, for starting a run. */
  presetForRun(
    presetId: string,
  ): Promise<{ preset: AgentPreset; apiKeyCipher: string | null } | null>;
  savePreset(record: PresetRecord): Promise<AgentPreset>;
  /** Also unassigns it from every column it ran. */
  deletePreset(presetId: string): Promise<void>;
  /** Marks a preset out of usage until a time, or clears that. */
  setPresetLimit(presetId: string, limit: { until: Date; note: string } | null): Promise<void>;
  columnAgents(projectId: string): Promise<ColumnAgents>;
  /** The saved agent the board's assistant runs on, or null. */
  assistantAgent(projectId: string): Promise<string | null>;
  setAssistantAgent(projectId: string, presetId: string | null): Promise<void>;
  /** The assistant conversation, oldest first. */
  assistantMessages(projectId: string): Promise<AssistantMessage[]>;
  assistantMessage(id: string): Promise<AssistantMessage | null>;
  addAssistantMessage(input: {
    projectId: string;
    role: "user" | "assistant";
    content: string;
    status?: AssistantMessage["status"];
  }): Promise<AssistantMessage>;
  updateAssistantMessage(
    id: string,
    update: Partial<Pick<AssistantMessage, "content" | "proposals" | "status" | "runnerJob" | "runnerAgent">>,
  ): Promise<void>;
  clearAssistant(projectId: string): Promise<void>;
  /** One card's chat, oldest first. */
  cardChatMessages(cardId: string): Promise<CardChatMessage[]>;
  cardChatMessage(id: string): Promise<CardChatMessage | null>;
  addCardChatMessage(input: {
    projectId: string;
    cardKind: "epic" | "ticket";
    cardId: string;
    role: "user" | "assistant";
    content: string;
    status?: CardChatMessage["status"];
  }): Promise<CardChatMessage>;
  updateCardChatMessage(
    id: string,
    update: Partial<Pick<CardChatMessage, "content" | "status" | "runnerJob">>,
  ): Promise<void>;
  clearCardChat(cardId: string): Promise<void>;
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
