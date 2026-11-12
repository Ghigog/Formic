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
  BugSeverity,
} from "@/lib/domain/entities";
import type { FollowUp } from "@/lib/agents/follow-ups";
import type { ColumnId, TicketStatus } from "@/lib/domain/status";
import type { ProviderId } from "@/lib/llm/providers";

/**
 * The data boundary. Two implementations: Prisma against Postgres, and an
 * in-memory store used when DATABASE_URL is unset so the app runs with no
 * infrastructure. Everything above this interface is storage-agnostic.
 */

/** How many running audits runningAuditJobs reads. */
export const RUNNING_AUDITS_LIMIT = 50;
/** How many of the newest Epic-carrying audits latestAudits reads; a report replaces its sentinel's earlier ones, so few exist. */
export const EPIC_AUDITS_LIMIT = 50;
/** Newest audits auditsFor returns. */
export const AUDITS_LIMIT = 200;
/** Cards per archive page. */
export const ARCHIVE_PAGE_LIMIT = 50;
/** Chat messages per page. */
export const MESSAGES_PAGE_LIMIT = 100;
/** Upper bound for the pending/orphaned chat lookups. */
export const PENDING_MESSAGES_LIMIT = 200;

/** One page of a card list: nextCursor is null on the last page. */
export interface CardPage {
  cards: BoardCard[];
  nextCursor: string | null;
}

/** One page of a conversation, oldest first; earlierCursor is null when nothing is earlier. */
export interface MessagePage<T> {
  messages: T[];
  earlierCursor: string | null;
}

export interface CreateEpicInput {
  projectId: string;
  title: string;
  rawRequest: string;
  position: number;
  workType?: WorkType | null;
  bugSeverity?: BugSeverity | null;
  /** The spike whose findings this Epic plans. Throws when it already has one. */
  spikeTicketId?: string | null;
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
  bugSeverity?: BugSeverity | null;
  /** Work for a person, not an agent: why. */
  needsHuman?: string | null;
  /** The ticket only moves or renames files. */
  moveOnly?: boolean;
}

/** A ticket's stay in one column. `exitedAt` is null while it is still there. */
export interface TicketColumnEntry {
  column: ColumnId;
  enteredAt: string;
  exitedAt: string | null;
  /** Stands in for history from before it was recorded: duration KPIs skip it. */
  synthetic: boolean;
}

/** A change to a ticket after it was specified: its points, its text, or a split. */
export interface TicketChange {
  kind: "points" | "edit" | "split";
  at: string;
  detail: Record<string, unknown> | null;
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
   * Tickets only. Dropped in a plain column ("No agent"): reaching merged
   * scores it like a merge, once, since no agent will merge it.
   */
  plain?: boolean;
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
  /** Who a reply comes from: "assistant", a column role or "sentinel:<id>" (a GuestId). */
  speaker: string;
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

/** A project's golden bell. */
export interface GoldenBellState {
  used: number;
  armed: boolean;
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
  /** How the audit scored each of its rubric's checks. */
  checks?: AuditCheck[];
}

/** One pass/fail statement in a rubric, worded so every audit reads it alike. */
export interface RubricCheck {
  /** Stable within its rubric: "3b" is the second check on the 3-star rung. */
  id: string;
  text: string;
  /** How an audit verifies it: a file to read or a command to run. */
  how: string;
  /**
   * The one shell command that decides the check, when there is one. Its
   * result, not the auditor's reading of it, sets whether the check is met.
   */
  command?: string | null;
  /** What passing looks like for the command: it prints nothing, or it exits 0. */
  pass?: CommandPass | null;
}

export type CommandPass = "empty" | "exit0";

/**
 * A sentinel's star ladder for one project, written by calibrating: rung 2
 * to 5, each earned when all its checks pass and every rung below is.
 */
export interface Rubric {
  /** What the project is, and what matters most for this role. */
  context: string;
  rungs: Array<{ stars: number; checks: RubricCheck[] }>;
}

export interface AuditCheck {
  id: string;
  met: boolean;
  /** The file and line read, or the command run and what it showed. */
  evidence: string;
  /** The check's command as the auditor ran it, when the check has one. */
  ran?: { exitCode: number; output: string } | null;
}

/**
 * Calibrating writes a rubric; auditing scores the code against one. A
 * project keeps at most two of each per sentinel: the last one that
 * finished, and a newer one running or failed.
 */
export type AuditKind = "audit" | "calibrate";

/**
 * One sentinel's audit of a project. A project keeps at most two per
 * sentinel: the last one that reported, and a newer one running or failed.
 */
export interface AuditRecord {
  id: string;
  projectId: string;
  sentinel: string;
  kind: AuditKind;
  status: "running" | "done" | "failed";
  /** Steps reached so far, oldest first. */
  log: string[];
  stars: number | null;
  /** The sentinel's one line, in character. */
  quote: string | null;
  summary: string | null;
  report: AuditReport | null;
  /** A calibration's rubric, or the one an audit was scored against. */
  rubric: Rubric | null;
  error: string | null;
  model: string | null;
  /** Files the sentinel read. */
  files: string[];
  /** The base branch head the audit read, or null when it could not be resolved. */
  commitSha: string | null;
  /** The GitHub Actions job a CLI agent audits in, while it runs. */
  runnerJob: string | null;
  runnerAgent: string | null;
  /** The Backlog Epic made from this report, if any. */
  epicId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface AuditResult {
  status: "done" | "failed";
  stars?: number;
  quote?: string;
  summary?: string;
  report?: AuditReport;
  /** A calibration's rubric. An audit keeps the one it started with. */
  rubric?: Rubric;
  error?: string;
  model?: string | null;
  files?: string[];
  /** Overrides the commit the audit started with. */
  commitSha?: string | null;
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
  /** Work an agent proposed as tickets of their own, for the person to add or dismiss. */
  followUps: FollowUp[];
  /** The head commit the Reviewer Agent last approved or pushed. */
  reviewedSha: string | null;
  /**
   * The head a review has already been given, answer or not. A report about
   * that same commit does not start another review while the card is parked
   * on it (see src/lib/review/pipeline.ts); null once the review has come
   * back, and after a person moves the card.
   */
  reviewedHead: string | null;
  /**
   * Stacked: the branch of the prerequisite whose open pull request this
   * ticket builds on, and its own pull request's base until that one merges.
   * Null on the merge target.
   */
  stackedOn: string | null;
  /** The ticket only moves or renames files. */
  moveOnly: boolean;
  /** When its run last pushed a commit or checkpoint (ISO). Null before any has. */
  lastCommitAt: string | null;
  /** What the first stuck run last did. Null once the ticket moves on. */
  stuckNote: string | null;
  /** Work for a person, not an agent: why. Null when an agent can do it. */
  needsHuman: string | null;
  /** When story points were auto-escalated (ISO), so it happens once. Null if never. */
  autoEscalatedAt: string | null;
  /** The kind of work, as the owner chose. Null for untyped. */
  workType: WorkType | null;
  /** How bad a bug is. Null unless workType is bug. */
  bugSeverity: BugSeverity | null;
  /** On a scout: the ticket it scouts for (docs/colony.md). Null on any other ticket. */
  scoutOf: string | null;
  /** On a scout: the approach it was told to take. */
  scoutBrief: string | null;
  /** On a scout: the agent template it runs on; null runs the column's. */
  scoutPresetId: string | null;
  /** On a parent: how many scouts it sent out, the one picked, and why. */
  scouts: number;
  scoutPick: string | null;
  scoutWhy: string | null;
}

export interface TicketUpdate {
  /** The ticket as written, when its column's agent rewrites it. */
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  fileScope?: string[];
  /** 1, 2, 3, 5, 8 or 13; null clears the estimate. */
  storyPoints?: number | null;
  /** The ticket type; null clears it. A type other than bug clears the severity. */
  workType?: WorkType | null;
  bugSeverity?: BugSeverity | null;
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
  followUps?: FollowUp[];
  reviewedSha?: string | null;
  reviewedHead?: string | null;
  stackedOn?: string | null;
  moveOnly?: boolean;
  /** When its run last pushed a commit or checkpoint; null clears it. */
  lastCommitAt?: Date | null;
  stuckNote?: string | null;
  scouts?: number;
  scoutPick?: string | null;
  scoutWhy?: string | null;
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
  /** Empty for a board with no repository (stored as null). */
  repoFullName: string;
  baseBranch: string;
  /** Formic merges approved, green pull requests on its own. Off until the owner opts in. */
  autoMerge: boolean;
  /** Formic raises a ticket's story points on its own when it outgrows its estimate. Off until the owner opts in. */
  autoEscalate: boolean;
  /** Every Sentinel is unlocked whatever the colony level. Off until the owner opts in. */
  unlockAllSentinels: boolean;
  /** When the offer to unlock every Sentinel was dismissed or taken up. Null: still on offer. */
  unlockAllOfferDismissedAt: Date | null;
  /** The most Coder Agents the board runs at once, scouts included. Null: no cap. */
  colonySize: number | null;
  /** Slots of colonySize kept for urgent work. */
  colonyReserve: number;
  /** Whether idle reserve slots send scouts out on their own. */
  autoScout: boolean;
  /** The saved agent scouts run on. Null: the In Progress column's agent. */
  scoutPresetId: string | null;
  /** Whether members may run on the owner's keys and agents when they have none. Off by default. */
  shareKeys: boolean;
}

/** Whose projects and presets a query sees. */
export interface OwnerScope {
  ownerId: string;
  /** Also the unowned ones: the demo board, and anything from before accounts. */
  includeUnowned: boolean;
}

/** One device's Web Push subscription. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A personal access token as stored: the sha256 of its secret, never the secret. */
export interface AccessTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  lastFour: string;
  readOnly: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export type NewAccessToken = Pick<AccessTokenRecord, "userId" | "name" | "tokenHash" | "lastFour" | "readOnly" | "expiresAt">;

/** Which push messages a person wants. */
export interface PushPreferences {
  ticketMoved: boolean;
  epicCompleted: boolean;
  needsAttention: boolean;
}

/** A person, with their credentials still sealed. */
export interface UserRecord {
  id: string;
  /** Null until the person connects GitHub. The local user's is 0. */
  githubId: number | null;
  /** Lowercased. Null for someone who has only signed in with GitHub. */
  email: string | null;
  emailVerifiedAt: Date | null;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  githubTokenCipher: string | null;
  githubTokenExpiresAt: Date | null;
  githubRefreshCipher: string | null;
  githubRefreshExpiresAt: Date | null;
  /** Null until the person connects gitlab.com. */
  gitlabId: number | null;
  gitlabLogin: string | null;
  gitlabTokenCipher: string | null;
  gitlabTokenExpiresAt: Date | null;
  gitlabRefreshCipher: string | null;
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
  /** Whether thinking effort follows story points; on when absent. */
  effortByPoints?: boolean;
  /** Push preferences; on when absent. */
  ticketMoved?: boolean;
  epicCompleted?: boolean;
  needsAttention?: boolean;
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
  effortByPoints?: boolean;
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
    | "gitlabTokenCipher"
    | "gitlabTokenExpiresAt"
    | "gitlabRefreshCipher"
    | "e2bKeyCipher"
    | "e2bKeyHint"
    | "anthropicKeyCipher"
    | "anthropicKeyHint"
  >
>;

/** A gitlab.com account, as connecting one records it. */
export interface GitlabAccount {
  gitlabId: number;
  login: string;
}

export interface GithubProfile {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** A one-time emailed sign-in link, as stored: only its hash. */
export interface NewLoginToken {
  email: string;
  tokenHash: string;
  next: string;
  ip: string | null;
  expiresAt: Date;
}

/** A preset as stored. The key arrives here already sealed. */
export interface PresetRecord {
  id?: string;
  /** Set on create; an update keeps the owner it had. */
  ownerId?: string | null;
  /**
   * Set on create. An update keeps the column it had, unless it had none:
   * a preset made before columns were scoped may be given one column once,
   * to stop it showing for every column's picker from then on.
   */
  column?: ColumnId | null;
  provider: ProviderId;
  name: string;
  model: string;
  prompt: string;
  /** Sealed key; null clears it; omitted keeps it. */
  apiKeyCipher?: string | null;
  apiKeyHint?: string | null;
  /** A CLI agent's Actions secret; null clears it; omitted keeps it. */
  secretName?: string | null;
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

/** The last reading of the host's own meter. See src/lib/usage/vercel.ts. */
export interface HostUsageCheck {
  checkedAt: Date;
  /** A VercelUsage, as it was read. */
  data: unknown;
}

/**
 * A running ticket's claim on its files. Claims are per repository, not per
 * board: two people's boards on one repository write the same files.
 */
export interface Reservation {
  ticketId: string;
  key: string;
  projectId: string;
  /** The GitHub login of the board's owner. Null for the demo board. */
  ownerLogin: string | null;
  fileScope: string[];
}

/** Projects: finding them and creating one for a repository. */
export interface ProjectRepository {
  /** The demo board: the first unowned project, created on demand. */
  defaultProject(): Promise<ProjectSummary>;
  listProjects(scope: OwnerScope): Promise<ProjectSummary[]>;
  /** Every project on a repository, whoever owns it. For webhooks. */
  projectsForRepo(repoFullName: string): Promise<ProjectSummary[]>;
  projectById(projectId: string): Promise<ProjectSummary | null>;
  /** Someone's project for a repository, created the first time they pick it. */
  ensureProject(input: {
    ownerId: string | null;
    /** Null for a board with no repository: always a new one, named by `name`. */
    repoFullName: string | null;
    name?: string;
    baseBranch: string;
  }): Promise<ProjectSummary>;
}

/** Sharing a board, and who opened it. */
export interface SharingRepository {
  /** Shares a project with someone. Doing it twice is harmless. */
  addMember(projectId: string, userId: string): Promise<void>;
  isMember(projectId: string, userId: string): Promise<boolean>;
  /** The projects shared with someone, oldest first. Not the ones they own. */
  memberProjects(userId: string): Promise<ProjectSummary[]>;
  /** Records that this person opened the project just now. An unknown project is ignored. */
  markOpened(userId: string, projectId: string): Promise<void>;
  /** When this person last opened each project, by project id. Never-opened ones are absent. */
  openedAtByProject(userId: string): Promise<Map<string, Date>>;
  /** Records that this person has taken the board's tour. Works before the first markOpened; an unknown project is ignored. */
  markBoardTourSeen(userId: string, projectId: string): Promise<void>;
  /** Whether this person has taken the board's tour on any device. */
  boardTourSeen(userId: string, projectId: string): Promise<boolean>;
  /** A member's own agents on a shared board, by column or "assistant". */
  memberAgents(projectId: string, userId: string): Promise<Record<string, string>>;
  setMemberAgent(projectId: string, userId: string, slot: string, presetId: string | null): Promise<void>;
  setShareKeys(projectId: string, shareKeys: boolean): Promise<void>;
  /**
   * Whose keys a card's work runs on: the person who last set it going. A
   * ticket with none takes its scout parent's, then its epic's. Null is the
   * board's owner.
   */
  cardActor(cardId: string): Promise<string | null>;
  setCardActor(cardId: string, userId: string | null): Promise<void>;
}

/** Access tokens. */
export interface TokenRepository {
  createAccessToken(token: NewAccessToken): Promise<AccessTokenRecord>;
  accessTokenByHash(tokenHash: string): Promise<AccessTokenRecord | null>;
  /** A person's tokens, newest first. */
  accessTokensForUser(userId: string): Promise<AccessTokenRecord[]>;
  /** Revokes a token only when it belongs to `userId`; false when nothing changed. */
  revokeAccessToken(userId: string, id: string): Promise<boolean>;
  touchAccessToken(id: string, at: Date): Promise<void>;
}

/** Push subscriptions and preferences. */
export interface PushRepository {
  /** Saves a device's push subscription; a known endpoint moves to this person with fresh keys. */
  savePushSubscription(userId: string, subscription: PushSubscriptionRecord): Promise<void>;
  /** Forgets a device, whoever it is saved for when `userId` is omitted. */
  deletePushSubscription(endpoint: string, userId?: string): Promise<void>;
  pushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  pushPreferences(userId: string): Promise<PushPreferences>;
  /** Stores the kinds given, leaves the rest; returns all three. */
  setPushPreferences(userId: string, prefs: Partial<PushPreferences>): Promise<PushPreferences>;
}

/** Coordination across boards and server instances. */
export interface CoordinationRepository {
  /**
   * Every running ticket on every board of a repository, and the files it
   * holds. A scout counts only while its parent runs: one left marked running
   * after its parent moved on has nothing working it, and would hold its
   * files for good.
   */
  reservations(repoFullName: string): Promise<Reservation[]>;
  /**
   * Takes `key` for `holder` for `ttlMs`, when nobody holds it, the holder
   * let it lapse, or `holder` already has it. True when it is now theirs.
   * Atomic across instances.
   */
  acquireLease(key: string, holder: string, ttlMs: number): Promise<boolean>;
  /**
   * Records one error now, forgets those before `windowStart`, and returns how
   * many are left in the window. Counts across every instance sharing the store.
   */
  recordErrorOccurrence(windowStart: Date): Promise<number>;
  /** Lets go of `key`, only if `holder` still has it. */
  releaseLease(key: string, holder: string): Promise<void>;
  /** Who holds `key` now, or null when nobody does or the holder let it lapse. */
  leaseHolder(key: string): Promise<string | null>;
}

/** People. */
export interface UserRepository {
  userById(userId: string): Promise<UserRecord | null>;
  /** Creates or refreshes someone from their GitHub profile. */
  upsertUser(profile: GithubProfile): Promise<UserRecord>;
  /** Someone by their (lowercased) email address. */
  userByEmail(email: string): Promise<UserRecord | null>;
  /** Someone by their GitHub account id. */
  userByGithubId(githubId: number): Promise<UserRecord | null>;
  /** Creates someone who signed in by email, verified now. */
  createEmailUser(user: { email: string; login: string }): Promise<UserRecord>;
  /** Attaches a GitHub account to an existing person, refreshing login, name and avatar from it. */
  linkGithub(userId: string, profile: GithubProfile): Promise<UserRecord>;
  /** Detaches GitHub: clears the GitHub id and every GitHub token. */
  unlinkGithub(userId: string): Promise<UserRecord>;
  /** The person who connected this gitlab.com account, if anyone has. */
  userByGitlabId(gitlabId: number): Promise<UserRecord | null>;
  /** Connects a gitlab.com account to a person. Refuses one already connected to someone else. */
  linkGitlab(userId: string, account: GitlabAccount): Promise<UserRecord>;
  /** Forgets a person's gitlab.com account and its tokens. */
  unlinkGitlab(userId: string): Promise<UserRecord>;
  /**
   * Folds an email account into a GitHub one when one person turns out to
   * have both: `from`'s boards, saved agents, access tokens and push
   * subscriptions move to `into`, `from` is removed, and `into` takes its
   * email. All or nothing. Memberships and "last opened" marks are dropped:
   * an account with no GitHub can't have joined a shared board.
   */
  mergeUserInto(fromId: string, intoId: string): Promise<UserRecord>;
  /** Stores a sign-in link's hash. */
  createLoginToken(token: NewLoginToken): Promise<void>;
  /**
   * Spends a sign-in link: marks it used and returns its email and next path,
   * or null when it is unknown, expired or already used. Atomic, so two
   * concurrent spends of one link sign in at most once.
   */
  spendLoginToken(tokenHash: string, now: Date): Promise<{ email: string; next: string } | null>;
  /** How many sign-in links were sent to this address, or from this IP, since `since`. */
  countLoginTokens(by: { email: string } | { ip: string }, since: Date): Promise<number>;
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
}

/** The board: cards, epics and their columns. */
export interface BoardRepository {
  /** Which project an epic or ticket belongs to. */
  projectOfCard(cardId: string): Promise<string | null>;
  /** Every ticket with an agent run live on it (running, or holding a runner job), on any board. */
  ticketsWithLiveRun(): Promise<Array<{ ticketId: string; projectId: string }>>;
  boardCards(projectId: string): Promise<BoardCard[]>;
  /** The archive: a project's archived tickets, off the active board. Those archived with their Epic show under it. */
  archivedTickets(projectId: string, page?: { cursor?: string; limit?: number }): Promise<CardPage>;
  /** The keys of an Epic's archived tickets, as archivedTickets lists them. */
  archivedTicketKeys(epicId: string): Promise<string[]>;
  /** The archive: a project's archived Epics. */
  archivedEpics(projectId: string, page?: { cursor?: string; limit?: number }): Promise<CardPage>;
  /**
   * Archives an Epic and each of its non-archived tickets, marking those as
   * taken by the Epic, in one transaction. Idempotent.
   */
  archiveEpic(epicId: string): Promise<void>;
  /** Restores an Epic and only the tickets its archive took. Idempotent. */
  restoreEpic(epicId: string): Promise<void>;
  createEpic(input: CreateEpicInput): Promise<BoardCard>;
  /** The id of the Epic made from a spike's findings, or null. */
  epicForSpike(ticketId: string): Promise<string | null>;
  /**
   * The next standalone ticket's number, T-<number>. Claimed atomically and
   * never reused, so a deleted ticket's key keeps meaning that ticket.
   */
  nextStandaloneTicketNumber(projectId: string): Promise<number>;
  createTickets(input: CreateTicketInput[]): Promise<BoardCard[]>;
  /** Adds dependency edges by ticket id, for dependencies that name tickets created elsewhere. */
  addDependencies(edges: Array<{ ticketId: string; dependsOnTicketId: string }>): Promise<void>;
  /** Makes an Epic wait for other Epics, by id. Waits it already has are kept, none twice. */
  setEpicWaits(epicId: string, waitsForEpicIds: string[]): Promise<void>;
  move(input: MoveInput): Promise<void>;
  /** Epics only: whether it is a holder with no card of its own. */
  setStandalone(epicId: string, standalone: boolean): Promise<void>;
  /** Where a card was rerouted from, and why. Null clears both fields. */
  setReroute(cardId: string, kind: "epic" | "ticket", reroute: Reroute | null): Promise<void>;
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
  /** `title`, when not blank, renames the Epic in the same update. */
  setEpicPrd(epicId: string, prd: unknown, byHuman: boolean, title?: string): Promise<void>;
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
  rebalanceColumn(projectId: string, column: ColumnId): Promise<void>;
}

/** Queens and the golden bell. */
export interface QueenRepository {
  /** Places a Queen on a card, or returns null when it already has one. */
  placeQueen(projectId: string, cardId: string, kind: CardKind): Promise<QueenRecord | null>;
  /** The Queens placed in a project. */
  listQueens(projectId: string): Promise<QueenRecord[]>;
  /** Takes a card's Queen off. It stays spent: see queensSpent. Returns whether there was one. */
  clearQueen(cardId: string): Promise<boolean>;
  /** How many Queens this project has taken off the board, never handed back. */
  queensSpent(projectId: string): Promise<number>;
  /** A project's golden bell: how many it has used and whether one is armed. */
  goldenBell(projectId: string): Promise<GoldenBellState>;
  /** Arms or disarms the project's golden bell. */
  setGoldenBellArmed(projectId: string, armed: boolean): Promise<void>;
  /** Spends the armed golden bell: counts it used and disarms it. Atomic; returns false when none was armed. */
  useGoldenBell(projectId: string): Promise<boolean>;
  /** The projects whose golden bell is armed, for the bell's clock. */
  armedGoldenBells(): Promise<string[]>;
}

/** Attachments. */
export interface AttachmentRepository {
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
  /** Moves a ticket's attachments to another, such as the ticket drafted from a placeholder. */
  moveTicketAttachments(fromTicketId: string, toTicketId: string): Promise<void>;
}

/** The board's event log. */
export interface EventRepository {
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
  /** The payload of a card's last `card.status` event before `beforeSeq`, or null. */
  cardStatusBefore(projectId: string, cardId: string, beforeSeq: number): Promise<unknown>;
  /** The same, but for events whose payload names an Epic. */
  epicEvents(
    projectId: string,
    epicId: string,
    types: string[],
    limit?: number,
  ): Promise<Array<{ seq: number; type: string; payload: unknown; at: Date }>>;
  /**
   * Events of the given types on any of these boards from `since` on, oldest
   * first. At most `limit`, the latest ones.
   */
  eventsOfTypes(
    projectIds: string[],
    types: string[],
    since: Date,
    limit?: number,
  ): Promise<Array<{ seq: number; projectId: string; type: string; payload: unknown; at: Date }>>;
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
}

/** Tickets: their history, details and scouts. */
export interface TicketRepository {
  /** Every column a ticket has been in, oldest first. */
  ticketColumnEntries(ticketId: string): Promise<TicketColumnEntry[]>;
  /** Every change recorded on a ticket after it was specified, oldest first. */
  ticketChanges(ticketId: string): Promise<TicketChange[]>;
  /** Records a change on a ticket. A split is recorded on the ticket that replaces the original. */
  recordTicketChange(ticketId: string, change: Pick<TicketChange, "kind" | "detail">): Promise<void>;
  ticketDetail(ticketId: string): Promise<TicketDetail | null>;
  /** The ticket a webhook is about. Pull request numbers are unique per repo. */
  ticketByPrNumber(
    projectId: string,
    prNumber: number,
  ): Promise<TicketDetail | null>;
  updateTicket(ticketId: string, update: TicketUpdate): Promise<void>;
  /** Every ticket under an Epic, for dependency gating and the showcase. Never scouts. */
  ticketsForEpic(epicId: string): Promise<TicketDetail[]>;
  /**
   * Makes a scout of `parentId` for each brief: a copy of the ticket, off the
   * board, numbered after it (FOR-14-s1, -s2, ...), ready to be sent out.
   */
  createScouts(parentId: string, briefs: Array<{ brief: string; presetId: string | null }>): Promise<TicketDetail[]>;
  /** A ticket's scouts, in the order they were sent. */
  scoutsOf(parentId: string): Promise<TicketDetail[]>;
  /**
   * Every GitHub issue number this project's mirror owns: each Epic's, and
   * each ticket's own or the one it was imported from. What the intake skips
   * before it will import anything, so an issue Formic filed is never filed
   * back in. Kept to numbers: it is read on a poll, and nothing else about
   * those rows is wanted.
   */
  mirroredIssueNumbers(projectId: string): Promise<number[]>;
  /** Records that the ticket's story points were auto-escalated; keeps the first time if already marked. */
  markTicketAutoEscalated(ticketId: string): Promise<void>;
}

/** PROT-06 / PROT-07: the ticket run lifecycle. */
export interface RunRepository {
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
}

/** Agent presets, and which one each column runs. */
export interface AgentRepository {
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
  /** The colony's size, reserve and auto-scouting (docs/colony.md). */
  setColony(projectId: string, colony: { colonySize: number | null; colonyReserve: number; autoScout: boolean }): Promise<void>;
  setScoutAgent(projectId: string, presetId: string | null): Promise<void>;
  setAutoEscalate(projectId: string, autoEscalate: boolean): Promise<void>;
  setUnlockAllSentinels(projectId: string, unlockAllSentinels: boolean): Promise<void>;
  /** Records that the offer to unlock every Sentinel was dismissed. Keeps the first time. */
  setUnlockAllOfferDismissed(projectId: string): Promise<void>;
  setColumnAgent(
    projectId: string,
    column: ColumnId,
    presetId: string | null,
  ): Promise<void>;
}

/** Conversations: the assistant and card chat. */
export interface ConversationRepository {
  /** One page of the assistant conversation, oldest first: the newest by default, or the ones before a message id. */
  assistantMessages(projectId: string, page?: { before?: string; limit?: number }): Promise<MessagePage<AssistantMessage>>;
  assistantMessage(id: string): Promise<AssistantMessage | null>;
  /** The oldest pending assistant message (of one role, if given), or null. */
  pendingAssistantMessage(projectId: string, role?: "user" | "assistant"): Promise<AssistantMessage | null>;
  /** The newest assistant answer that is not pending, or null. */
  lastAssistantAnswer(projectId: string): Promise<AssistantMessage | null>;
  addAssistantMessage(input: {
    projectId: string;
    role: "user" | "assistant";
    content: string;
    status?: AssistantMessage["status"];
    speaker?: string;
  }): Promise<AssistantMessage>;
  updateAssistantMessage(
    id: string,
    update: Partial<Pick<AssistantMessage, "content" | "proposals" | "status" | "runnerJob" | "runnerAgent">>,
  ): Promise<void>;
  clearAssistant(projectId: string): Promise<void>;
  /** One page of a card's chat, oldest first: the newest by default, or the ones before a message id. */
  cardChatMessages(cardId: string, page?: { before?: string; limit?: number }): Promise<MessagePage<CardChatMessage>>;
  cardChatMessage(id: string): Promise<CardChatMessage | null>;
  /** A card's pending chat message, or null. */
  pendingCardChatMessage(cardId: string): Promise<CardChatMessage | null>;
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
}

/** Sentinels: audits. */
export interface AuditRepository {
  /** A project's newest audits, oldest first. */
  auditsFor(projectId: string): Promise<AuditRecord[]>;
  /** An audit is started with the rubric it will be scored against. */
  startAudit(
    projectId: string,
    sentinel: string,
    kind?: AuditKind,
    rubric?: Rubric | null,
    commitSha?: string | null,
  ): Promise<AuditRecord>;
  /** A project's running audits that wait on a CLI agent's job. */
  runningAuditJobs(projectId: string): Promise<AuditRecord[]>;
  /**
   * The audits sentinelStates needs, without the whole history: per sentinel
   * the newest audit, the newest done audit, the newest done calibration
   * with a rubric, and the newest audits that carry an Epic. Oldest first.
   */
  latestAudits(projectId: string): Promise<AuditRecord[]>;
  /** One audit by id, or null. */
  auditDetail(id: string): Promise<AuditRecord | null>;
  /** Adds a step to a running audit's log; with `replace`, it takes the place of the latest one. */
  logAudit(id: string, step: string, replace?: boolean): Promise<void>;
  /** Records the GitHub Actions job a CLI agent audits in; only its result is taken. */
  setAuditJob(id: string, job: string | null, agent: string | null): Promise<void>;
  /**
   * Ends an audit. A report replaces the sentinel's earlier ones of the same
   * kind; a failure keeps the last report, so a bad run never costs the
   * project its stars or its rubric.
   */
  finishAudit(id: string, result: AuditResult): Promise<void>;
  /** Records the Epic made from an audit's report. */
  markAuditEpic(auditId: string, epicId: string): Promise<void>;
}

/** Webhook deliveries. */
export interface DeliveryRepository {
  /**
   * Records a webhook delivery, returning false when it has been seen before.
   * GitHub delivers at least once and out of order; this is what makes a
   * redelivery a no-op rather than a second fix commit.
   */
  claimDelivery(key: string): Promise<boolean>;
}

/** Host usage. */
export interface UsageRepository {
  /**
   * Adds to the host usage counted for one UTC day ("YYYY-MM-DD"), and
   * returns that day's total with the total of every day from `sinceDay` on.
   * See src/lib/usage/governor.ts.
   */
  addPlatformUsage(day: string, delta: PlatformUsage, sinceDay: string): Promise<PlatformUsageTotals>;
  /** Each counted day from `sinceDay` on. */
  platformUsageByDay(sinceDay: string): Promise<Record<string, PlatformUsage>>;
  /** The last reading of the host's own meter, or null before the first. */
  hostUsageCheck(): Promise<HostUsageCheck | null>;
  saveHostUsageCheck(check: HostUsageCheck): Promise<void>;
}

/** The whole persistence port: every aggregate's repository in one. */
export interface Repository
  extends ProjectRepository,
    SharingRepository,
    TokenRepository,
    PushRepository,
    CoordinationRepository,
    UserRepository,
    BoardRepository,
    QueenRepository,
    AttachmentRepository,
    EventRepository,
    TicketRepository,
    RunRepository,
    AgentRepository,
    ConversationRepository,
    AuditRepository,
    DeliveryRepository,
    UsageRepository {}
