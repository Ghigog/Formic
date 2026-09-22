import "server-only";

import type {
  AgentRole,
  AgentRunStatus,
  BoardCard,
} from "@/lib/domain/entities";
import type { ColumnId, TicketStatus } from "@/lib/domain/status";

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
  name: string;
  repoFullName: string;
  baseBranch: string;
}

export interface Repository {
  defaultProject(): Promise<ProjectSummary>;
  boardCards(projectId: string): Promise<BoardCard[]>;
  createEpic(input: CreateEpicInput): Promise<BoardCard>;
  createTickets(input: CreateTicketInput[]): Promise<BoardCard[]>;
  move(input: MoveInput): Promise<void>;
  /** Positions in a column, ascending, for fractional index placement. */
  columnPositions(projectId: string, column: ColumnId): Promise<number[]>;
  cardById(id: string): Promise<BoardCard | null>;
  epicDetail(
    epicId: string,
  ): Promise<{ title: string; rawRequest: string; prd: unknown } | null>;
  setEpicPrd(epicId: string, prd: unknown, byHuman: boolean): Promise<void>;
  setEpicShowcase(epicId: string, markdown: string): Promise<void>;
  appendEvent(projectId: string, type: string, payload: unknown): Promise<number>;
  eventsAfter(
    projectId: string,
    seq: number,
    limit?: number,
  ): Promise<Array<{ seq: number; type: string; payload: unknown; at: Date }>>;
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
   * Runs still marked live. After a restart these are by definition orphans:
   * the process that owned their sandbox is gone.
   */
  unfinishedRuns(): Promise<Array<RunRecord & { status: AgentRunStatus }>>;

  /**
   * Records a webhook delivery, returning false when it has been seen before.
   * GitHub delivers at least once and out of order; this is what makes a
   * redelivery a no-op rather than a second fix commit.
   */
  claimDelivery(key: string): Promise<boolean>;
}
