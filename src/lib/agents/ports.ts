import type { Prd } from "@/lib/domain/entities";
import type { FormicEvent } from "@/lib/domain/events";
import type { Workspace } from "@/lib/sandbox/workspace";
import type { ProviderId } from "@/lib/llm/providers";

/**
 * The agent boundary. Every pipeline is reachable through one of these, and
 * every one has a mock implementation in ./mock.ts, so the board, the
 * persistence layer and the realtime transport can all be built and demoed
 * before a single real model call exists.
 *
 * Swapping a mock for the real thing is a single line in ./registry.ts.
 */

export interface AgentContext {
  runId: string;
  projectId: string;
  /** Publish a realtime event. Never throws; drops on a closed channel. */
  emit: (event: FormicEvent) => void;
  /** Cooperative cancellation: budgets, the kill switch, and user cancel. */
  signal: AbortSignal;
  /**
   * Records spend mid-run. A single-call agent can leave this alone and let
   * the pipeline account for it at the end; a loop cannot, because a budget
   * that is only checked after the loop finishes is not a budget.
   */
  charge?: (usage: Usage) => Promise<void>;
  /**
   * Whether the person watching the ticket stopped the run, and the notes
   * they sent it since it started. A loop asks between turns.
   */
  interrupts?: () => Promise<{ stopped: string | null; notes: string[] }>;
}

/**
 * What a saved preset changes about an agent. Anything unset keeps the
 * built-in choice: the pipeline's model, its brief, the server's API key.
 */
export interface AgentConfig {
  /** Which provider runs it. Unset means Claude, the built-in default. */
  provider?: ProviderId;
  model?: string;
  /** Replaces the built-in brief. Coding rules are still appended. */
  brief?: string;
  apiKey?: string | null;
}

export interface Usage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

export type AgentOutcome<T> =
  | { ok: true; value: T; usage: Usage }
  | { ok: false; error: string; blocked: boolean; usage: Usage };

/**
 * What an agent needs to see or read one attachment, independent of how it
 * is stored: an image is handed to the model as base64, a text file as its
 * decoded content.
 */
export interface AgentAttachment {
  id: string;
  filename: string;
  mimeType: string;
  kind: "image" | "file";
  base64?: string;
  text?: string;
}

/** PROT-03. Raw feature request in, structured Epic PRD out. */
export interface ProductAgent {
  draftPrd(
    ctx: AgentContext,
    input: { epicId: string; rawRequest: string; attachments: AgentAttachment[] },
  ): Promise<
    AgentOutcome<
      | { kind: "prd"; title: string; prd: Prd }
      | { kind: "reroute"; reason: string; ticket: DraftTicket }
    >
  >;
}

export interface DraftTicket {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  size: "S" | "M" | "L" | "XL";
  /** 1, 2, 3, 5, 8 or 13. */
  storyPoints?: number;
  dependsOn: string[];
}

/** One child ticket as it stands before a re-decomposition changes it. */
export interface ExistingTicket {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  storyPoints?: number;
  /** Already has a branch or pull request: decomposing again cannot replace it. */
  inFlight: boolean;
}

/** PROT-04. Epic PRD in, validated child ticket DAG out. */
export interface ArchitectAgent {
  decompose(
    ctx: AgentContext,
    input: {
      epicId: string;
      title: string;
      prd: Prd;
      repoTree: string[];
      /** The Epic's current tickets, when this decomposes it again. */
      existing?: ExistingTicket[];
      /** What the person asked of this breakdown, oldest first. */
      instructions?: string[];
    },
  ): Promise<AgentOutcome<DraftTicket[]>>;
  /** A To Do request: no PRD, just the raw text and one ticket to draft. */
  draftTicket(
    ctx: AgentContext,
    input: { rawRequest: string; repoTree: string[]; attachments: AgentAttachment[] },
  ): Promise<
    AgentOutcome<{ kind: "ticket"; ticket: DraftTicket } | { kind: "reroute"; reason: string }>
  >;
}

/** PROT-08. Merged diffs in, showcase document out. */
export interface ShowcaseAgent {
  summarize(
    ctx: AgentContext,
    input: {
      epicId: string;
      title: string;
      prd: Prd | null;
      ticketSummaries: Array<{ key: string; title: string; summary: string }>;
    },
  ): Promise<AgentOutcome<string>>;
}


/**
 * What a coding agent is handed. The workspace is already scoped: writes
 * outside `fileScope` throw before they reach the checkout, so the agent
 * learns its boundary from an error it can act on rather than from a run that
 * is rejected twenty minutes later.
 */
export interface CoderTask {
  ticketId: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  /** What the person watching the ticket told its agents, oldest first. */
  notes?: string[];
}

export interface CodeChange {
  /** One line for the card and the PR title. */
  summary: string;
  /** Commit body. What changed and why, not a list of files. */
  detail: string;
  /** Command the agent verified the change with, if it found one. */
  verifiedWith: string | null;
  /**
   * The repository already did what the ticket asks, so nothing was changed.
   * `detail` then holds the evidence, criterion by criterion.
   */
  alreadyDone?: boolean;
  /** Steps outside the repository the person has to take, if any. */
  handoff?: string[];
}

/** PROT-06. Ticket in, edited workspace out. Commits and pushes are the caller's. */
export interface CoderAgent {
  implement(
    ctx: AgentContext,
    input: { task: CoderTask; workspace: Workspace },
  ): Promise<AgentOutcome<CodeChange>>;
}

export interface FailingCheck {
  name: string;
  summary: string;
  annotations: Array<{ path: string; line: number | null; message: string }>;
}

/** What the Reviewer Agent is handed: the pull request, checked out. */
export interface ReviewTask {
  task: CoderTask;
  /** On the pull request's branch, scoped like the Coder Agent's. */
  workspace: Workspace;
  /** The branch the pull request merges into, to diff against. */
  baseBranch: string;
  /** The files the pull request changes. */
  changedFiles: string[];
  /** Red CI on the head. Empty when it is green. */
  checks: FailingCheck[];
  attempt: number;
  maxAttempts: number;
}

/**
 * The review's outcome. A workspace with changes in it is a fix; none, and
 * no reason to send it back, is an approval.
 */
export interface ReviewVerdict extends CodeChange {
  /** Why the ticket goes back to the Coder Agent, when it does. */
  sendBack: string | null;
}

/**
 * PROT-07. Every pull request, before it merges: read against the ticket's
 * acceptance criteria, then approved, fixed, or sent back with a reason.
 */
export interface ReviewerAgent {
  review(ctx: AgentContext, input: ReviewTask): Promise<AgentOutcome<ReviewVerdict>>;
}

export interface AgentRegistry {
  product: ProductAgent;
  architect: ArchitectAgent;
  coder: CoderAgent;
  reviewer: ReviewerAgent;
  showcase: ShowcaseAgent;
}
