import type { Prd } from "@/lib/domain/entities";
import type { FormicEvent } from "@/lib/domain/events";

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

export interface AgentRegistry {
  product: ProductAgent;
  architect: ArchitectAgent;
  showcase: ShowcaseAgent;
}
