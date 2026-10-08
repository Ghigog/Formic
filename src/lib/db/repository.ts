import "server-only";

import type {
  AgentPreset,
  AgentRole,
  AgentRunStatus,
  AttachmentKind,
  AttachmentSummary,
  BoardCard,
  CardKind,
  ColumnAgents,
  ColumnOverride,
  ColumnOverrides,
  PlanStep,
  WorkType,
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
  workType?: WorkType | null;
}

export interface CreateTicketInput {
  epicId: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  /** @deprecated Story points are the estimate; left out, it is stored as "M". */
  size?: "S" | "M" | "L" | "XL";
  storyPoints?: number | null;
  position: number;
  dependsOnKeys: string[];
  workType?: WorkType | null;
  /** Work for a person, not an agent: why. */
  needsHuman?: string | null;
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
  /**
   * The saved agent that answered, when one was on it: the preset whose plan
   * or key paid. A chat answer is not a run, so it is this — not a run row —
   * that says whose tokens the answer spent (see agentTokensByPreset).
   */
  agentPresetId: string | null;
  /**
   * What the answer spent. An answer made in this process is not a run, so
   * there is no run row to carry this: the message is where it is written
   * (see src/lib/agents/card-chat.ts). A person's message and a CLI agent's
   * answer leave these at zero — the latter's spend is its job's run.
   */
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  createdAt: Date;
}

/** One point in a sentinel's report, with the file it is about if any. */
export interface AuditPoint {
  text: string;
  ref: string | null;
}

export interface AuditReport {
  likes: AuditPoint[];
  dislikes: AuditPoint[];
  wrong: AuditPoint[];
  missing: AuditPoint[];
}

/**
 * One sentinel's audit of a project. A project keeps at most two per
 * sentinel: the last one that reported, and a newer one running or failed.
 */
export interface AuditRecord {
  id: string;
  projectId: string;
  sentinel: string;
  status: "running" | "done" | "failed";
  /** Steps reached so far, oldest first. */
  log: string[];
  stars: number | null;
  /** The sentinel's one line, in character. */
  quote: string | null;
  summary: string | null;
  report: AuditReport | null;
  error: string | null;
  model: string | null;
  /** Files the sentinel read. */
  files: string[];
  /** The GitHub Actions job a CLI agent audits in, while it runs. */
  runnerJob: string | null;
  runnerAgent: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface AuditResult {
  status: "done" | "failed";
  stars?: number;
  quote?: string;
  summary?: string;
  report?: AuditReport;
  error?: string;
  model?: string | null;
  files?: string[];
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
  /**
   * Files outside the scope its agent needed, asked of the person. Kept
   * until the work that needed them goes on or is dropped; see
   * src/lib/coder/scope-request.ts.
   */
  scopeRequest: string[];
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
  /**
   * The GitHub issue this ticket was imported from, when it came in from one.
   * The mirror adopts that issue as this ticket's own rather than filing a
   * second one; see `ensureTicketIssue` in src/lib/issues/sync.ts.
   */
  sourceIssueNumber: number | null;
  storyPoints: number | null;
  /** The plan the agent is working through, oldest step first. */
  plan: PlanStep[];
  /** Steps outside the repository the person has to take. */
  handoff: string[];
  /** The head commit the Reviewer Agent last approved or pushed. */
  reviewedSha: string | null;
  /**
   * The head a review has already been given, answer or not. A report about
   * that same commit does not start another review while the card is parked
   * on it (see src/lib/review/pipeline.ts); null once the review has come
   * back, and after a person moves the card.
   */
  reviewedHead: string | null;
  /** Work for a person, not an agent: why. Null when an agent can do it. */
  needsHuman: string | null;
}

export interface TicketUpdate {
  /** The ticket as written, when its column's agent rewrites it. */
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  fileScope?: string[];
  /** 1, 2, 3, 5, 8 or 13; null clears the estimate. */
  storyPoints?: number | null;
  /** Bug or spike; null clears it. */
  workType?: WorkType | null;
  scopeRequest?: string[];
  needsHuman?: string | null;
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
  /** The GitHub issue it was imported from, set once, at import. */
  sourceIssueNumber?: number | null;
  /** Cleared from active view without being deleted; the archive epic reads it. */
  archived?: boolean;
  plan?: PlanStep[];
  handoff?: string[];
  reviewedSha?: string | null;
  reviewedHead?: string | null;
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
  /** The saved agent that ran it, when one did: whose plan or key paid. */
  presetId?: string | null;
  sandboxId: string | null;
}

export interface RunOutcome {
  status: AgentRunStatus;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

export interface QueenRecord {
  projectId: string;
  cardId: string;
  kind: CardKind;
  placedAt: Date;
}

export interface ProjectSummary {
  id: string;
  /** Null for the demo board, which belongs to no one. */
  ownerId: string | null;
  name: string;
  repoFullName: string;
  baseBranch: string;
  /** Formic merges approved, green pull requests on its own. Off until the owner opts in. */
  autoMerge: boolean;
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
  /** Sessions signed under an older version have been signed out. */
  sessionVersion: number;
  /** Sandbox seconds on the operator's E2B key in `fallbackSandboxMonth`. */
  fallbackSandboxSeconds: number;
  /** "YYYY-MM" (UTC) that the seconds above were spent in. */
  fallbackSandboxMonth: string | null;
  /** Run time budget columns; read and written through src/lib/user-settings. */
  runTimeBudgetMode: RunTimeBudgetColumns["runTimeBudgetMode"];
  runTimeBudgetFlatMinutes: number | null;
  /** Stored JSON: story points to minutes, e.g. {"1":5}. */
  runTimeBudgetPerPointMinutes: unknown;
  /** Minutes one story point buys in PER_STORY_POINT mode; null means the default. */
  runTimeBudgetPerPointRate: number | null;
  /** Stored limit settings (JSON), or null for the default. Read through src/lib/user-settings. */
  tokenLimit?: unknown;
  attemptLimit?: unknown;
  /** Token window: renewal day of the month (1-31) in `tokenWindowTimezone` (IANA), or null. */
  tokenRenewalDay: number | null;
  tokenWindowTimezone: string | null;
  /** When the person last reset the token count by hand, or null. */
  tokenResetAt: Date | null;
}

/** Limit settings to store; an omitted axis is left alone, null returns it to the default. */
export interface LimitColumns {
  tokenLimit?: Record<string, unknown> | null;
  attemptLimit?: Record<string, unknown> | null;
}

/** What a person's run time budget is stored as on their row. */
export interface RunTimeBudgetColumns {
  runTimeBudgetMode: "OFF" | "PER_STORY_POINT" | "FLAT_MINUTES" | "PER_POINT";
  runTimeBudgetFlatMinutes: number | null;
  /** A JSON object, or null for none. */
  runTimeBudgetPerPointMinutes: Record<string, number> | null;
  /** Minutes one story point buys, or null to keep the default. */
  runTimeBudgetPerPointRate: number | null;
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
  /** Set on create; an update keeps the column it had. */
  column?: ColumnId | null;
  provider: ProviderId;
  name: string;
  model: string;
  prompt: string;
  /** Sealed key; null clears it; omitted keeps it. */
  apiKeyCipher?: string | null;
  apiKeyHint?: string | null;
}

/** What the host has done for this deployment, as Formic counts it. */
export interface PlatformUsage {
  /** Requests served. */
  requests: number;
  /** Wall-clock milliseconds a function was kept busy. */
  busyMs: number;
  /** Milliseconds of CPU a function spent. */
  cpuMs: number;
}

export interface PlatformUsageTotals {
  today: PlatformUsage;
  window: PlatformUsage;
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
  updateRunTimeBudget(userId: string, columns: RunTimeBudgetColumns): Promise<UserRecord>;
  updateLimits(userId: string, columns: LimitColumns): Promise<UserRecord>;
  /** Sets (or with nulls clears) the day the token window renews and the timezone it is read in. */
  updateTokenRenewal(
    userId: string,
    renewal: { tokenRenewalDay: number | null; tokenWindowTimezone: string | null },
  ): Promise<UserRecord>;
  /** Stamps the token window as reset at `at`. */
  stampTokenReset(userId: string, at: Date): Promise<UserRecord>;
  /** Records that this person agreed to a version of the terms, now. */
  acceptTerms(userId: string, version: string): Promise<UserRecord>;
  /** Signs this person out everywhere: every session cookie issued so far stops working. */
  bumpSessionVersion(userId: string): Promise<UserRecord>;
  /** Adds sandbox time spent on the operator's E2B key, starting over when `month` is new. */
  addFallbackSandboxSeconds(userId: string, seconds: number, month: string): Promise<UserRecord>;
  countUsers(): Promise<number>;
  /** Gives a user every unowned project and preset. */
  adoptUnowned(userId: string): Promise<void>;
  /** Removes a person and everything they own: projects, presets, and all that cascades from those. */
  deleteUser(userId: string): Promise<void>;
  /** Which project an epic or ticket belongs to. */
  projectOfCard(cardId: string): Promise<string | null>;
  boardCards(projectId: string): Promise<BoardCard[]>;
  /** Places a Queen on a card, or returns null when it already has one. */
  placeQueen(projectId: string, cardId: string, kind: CardKind): Promise<QueenRecord | null>;
  /** The Queens placed in a project. */
  listQueens(projectId: string): Promise<QueenRecord[]>;
  /** Takes a card's Queen off. It stays spent: see queensSpent. Returns whether there was one. */
  clearQueen(cardId: string): Promise<boolean>;
  /** How many Queens this project has taken off the board, never handed back. */
  queensSpent(projectId: string): Promise<number>;
  /** The archive: a project's archived tickets, off the active board. */
  archivedTickets(projectId: string): Promise<BoardCard[]>;
  createEpic(input: CreateEpicInput): Promise<BoardCard>;
  /**
   * The next standalone ticket's number, T-<number>. Claimed atomically and
   * never reused, so a deleted ticket's key keeps meaning that ticket.
   */
  nextStandaloneTicketNumber(projectId: string): Promise<number>;
  createTickets(input: CreateTicketInput[]): Promise<BoardCard[]>;
  /** Adds dependency edges by ticket id, for dependencies that name tickets created elsewhere. */
  addDependencies(edges: Array<{ ticketId: string; dependsOnTicketId: string }>): Promise<void>;
  move(input: MoveInput): Promise<void>;
  /** Epics only: whether it is a holder with no card of its own. */
  setStandalone(epicId: string, standalone: boolean): Promise<void>;
  /** Where a card was rerouted from, and why. Null clears both fields. */
  setReroute(cardId: string, kind: "epic" | "ticket", reroute: Reroute | null): Promise<void>;
  createAttachment(input: CreateAttachmentInput): Promise<AttachmentSummary>;
  attachmentsFor(ref: AttachmentRef): Promise<AttachmentSummary[]>;
  /**
   * Which project an attachment belongs to, and the request id it is still
   * waiting under (null once a card has claimed it). The whole of what a read
   * has to check, in one query: a route that read the board to work this out
   * paid for the board every time an image loaded.
   */
  attachmentScope(id: string): Promise<{ projectId: string; requestId: string | null } | null>;
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
    /** The PM Agent's closing write-up, once every ticket has merged. */
    showcase: string | null;
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
  /**
   * Drops the oldest frames of a board's own log, keeping its newest `keep`
   * of them, and returns how many rows went. Only the frames nothing reads
   * back (`PRUNABLE_EVENT_TYPES`): a state change is never touched, and a
   * client that reconnects from a cursor older than the cut loses log lines
   * only, which `isDroppable` already says it may.
   */
  pruneEvents(projectId: string, keep: number): Promise<number>;
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
  /**
   * Every GitHub issue number this project's mirror owns: each Epic's, and
   * each ticket's own or the one it was imported from. What the intake skips
   * before it will import anything, so an issue Formic filed is never filed
   * back in. Kept to numbers: it is read on a poll, and nothing else about
   * those rows is wanted.
   */
  mirroredIssueNumbers(projectId: string): Promise<number[]>;

  startRun(run: RunRecord): Promise<void>;
  /** Milliseconds a ticket's agent runs have taken, a live one counted up to now. */
  ticketRunMs(ticketId: string): Promise<number>;
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
   * What an Epic's runs have actually taken: the time they ran, summed (a run
   * still going counts up to now), and how many attempts failed or were
   * blocked. What the Epic's time and attempt ceilings read.
   */
  epicRunStats(epicId: string): Promise<{ elapsedMs: number; attempts: number }>;
  /**
   * What every saved agent has used, in tokens, keyed by preset id: its runs
   * and the chat answers it gave, summed together. Tokens, not money: a
   * flat-rate plan such as ClinePass costs nothing per token, and a direct
   * key's prices are a table this repo maintains by hand, so tokens are the
   * one number every provider reports and nobody has to trust a rate for
   * (see budget/limits.ts).
   *
   * `since` narrows it to work done after a moment, for a plan that resets
   * monthly; null or omitted counts everything the board still holds. An id
   * with no work of its own is simply absent from the map.
   */
  agentTokensByPreset(
    since?: Date | null,
  ): Promise<Record<string, { tokensIn: number; tokensOut: number }>>;
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
  /** The overrides on a board's column agents, by column. */
  columnOverrides(projectId: string): Promise<ColumnOverrides>;
  /** Sets a column agent's override; false when the column has no agent. */
  setColumnOverride(projectId: string, column: ColumnId, override: ColumnOverride): Promise<boolean>;
  /** Sets or clears (null tokens) a preset's token allowance; null window means the default. */
  setPresetAllowance(presetId: string, allowance: { tokens: number | null; windowDays: number | null }): Promise<void>;
  /** The saved agent the board's assistant runs on, or null. */
  assistantAgent(projectId: string): Promise<string | null>;
  setAssistantAgent(projectId: string, presetId: string | null): Promise<void>;
  setAutoMerge(projectId: string, autoMerge: boolean): Promise<void>;
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
    update: Partial<
      Pick<
        CardChatMessage,
        "content" | "status" | "runnerJob" | "agentPresetId" | "tokensIn" | "tokensOut" | "costCents"
      >
    >,
  ): Promise<void>;
  clearCardChat(cardId: string): Promise<void>;
  /** A board's card chat answers a CLI agent is still writing in GitHub Actions. */
  pendingCardChatJobs(projectId: string): Promise<CardChatMessage[]>;
  /**
   * A board's card chat answers nothing is behind any more: no job, and older
   * than any function could still be writing one. What is left of an answer
   * whose worker died. See recoverStaleCardChats.
   */
  orphanedCardChats(projectId: string, olderThan: Date): Promise<CardChatMessage[]>;
  /**
   * The board assistant's answers nothing is behind any more: pending, no
   * job, older than the cut-off. See recoverStaleAssistantAnswers.
   */
  orphanedAssistantAnswers(projectId: string, olderThan: Date): Promise<AssistantMessage[]>;
  setColumnAgent(
    projectId: string,
    column: ColumnId,
    presetId: string | null,
  ): Promise<void>;

  /* Sentinels. */

  /** Every audit a project keeps, oldest first. */
  auditsFor(projectId: string): Promise<AuditRecord[]>;
  startAudit(projectId: string, sentinel: string): Promise<AuditRecord>;
  /** Adds a step to a running audit's log. */
  logAudit(id: string, step: string): Promise<void>;
  /** Records the GitHub Actions job a CLI agent audits in; only its result is taken. */
  setAuditJob(id: string, job: string | null, agent: string | null): Promise<void>;
  /**
   * Ends an audit. A report replaces the sentinel's earlier ones; a failure
   * keeps the last report, so a bad run never costs the project its stars.
   */
  finishAudit(id: string, result: AuditResult): Promise<void>;

  /**
   * Records a webhook delivery, returning false when it has been seen before.
   * GitHub delivers at least once and out of order; this is what makes a
   * redelivery a no-op rather than a second fix commit.
   */
  claimDelivery(key: string): Promise<boolean>;

  /**
   * Adds to the host usage counted for one UTC day ("YYYY-MM-DD"), and
   * returns that day's total with the total of every day from `sinceDay` on.
   * See src/lib/usage/governor.ts.
   */
  addPlatformUsage(day: string, delta: PlatformUsage, sinceDay: string): Promise<PlatformUsageTotals>;
}
