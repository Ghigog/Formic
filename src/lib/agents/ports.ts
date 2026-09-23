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

/** PROT-03. Raw feature request in, structured Epic PRD out. */
export interface ProductAgent {
  draftPrd(
    ctx: AgentContext,
    input: { epicId: string; rawRequest: string },
  ): Promise<AgentOutcome<{ title: string; prd: Prd }>>;
}

export interface DraftTicket {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  size: "S" | "M" | "L" | "XL";
  dependsOn: string[];
}

/** PROT-04. Epic PRD in, validated child ticket DAG out. */
export interface ArchitectAgent {
  decompose(
    ctx: AgentContext,
    input: { epicId: string; title: string; prd: Prd; repoTree: string[] },
  ): Promise<AgentOutcome<DraftTicket[]>>;
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
}

export interface CodeChange {
  /** One line for the card and the PR title. */
  summary: string;
  /** Commit body. What changed and why, not a list of files. */
  detail: string;
  /** Command the agent verified the change with, if it found one. */
  verifiedWith: string | null;
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

/** PROT-07. Red CI in, fix in the workspace out. */
export interface ReviewerAgent {
  fix(
    ctx: AgentContext,
    input: {
      task: CoderTask;
      workspace: Workspace;
      checks: FailingCheck[];
      attempt: number;
      maxAttempts: number;
    },
  ): Promise<AgentOutcome<CodeChange>>;
}

export interface AgentRegistry {
  product: ProductAgent;
  architect: ArchitectAgent;
  coder: CoderAgent;
  reviewer: ReviewerAgent;
  showcase: ShowcaseAgent;
}
