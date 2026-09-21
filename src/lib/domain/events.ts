import { AGENT_ROLES } from "./entities";

/**
 * Everything the client learns about asynchronously. Delivered over SSE by
 * PROT-10; persisted to the `event` table so a reconnecting client can replay
 * from a cursor instead of showing a gap.
 */

export type FormicEvent =
  | {
      type: "card.status";
      cardId: string;
      kind: "epic" | "ticket";
      status: string;
      stalledIn: string | null;
      stage: number;
      blockedReason: string | null;
    }
  | {
      type: "card.created";
      cardId: string;
      kind: "epic" | "ticket";
      epicId: string | null;
    }
  | {
      type: "epic.prd";
      epicId: string;
      /** Incremental text while the Product Agent streams. */
      delta: string;
      done: boolean;
    }
  | {
      type: "epic.showcase";
      epicId: string;
      markdown: string;
    }
  | {
      type: "run.progress";
      runId: string;
      ticketId: string | null;
      role: (typeof AGENT_ROLES)[number];
      label: string;
      /** 0..1, or null when the step has no measurable progress. */
      fraction: number | null;
    }
  | {
      type: "run.log";
      runId: string;
      stream: "stdout" | "stderr";
      line: string;
    }
  | {
      type: "run.diff";
      runId: string;
      path: string;
      /** Unified diff hunk for the file as it currently stands. */
      patch: string;
    }
  | {
      type: "run.usage";
      runId: string;
      tokensIn: number;
      tokensOut: number;
      costCents: number;
    }
  | {
      type: "run.finished";
      runId: string;
      status: "succeeded" | "failed" | "blocked" | "cancelled";
      error: string | null;
    }
  | {
      type: "ci.status";
      ticketId: string;
      prNumber: number;
      state: "pending" | "passing" | "failing";
      checkName: string | null;
    }
  | {
      type: "sandbox.count";
      active: number;
      provider: string;
    }
  | {
      type: "budget.exhausted";
      scope: "run" | "epic" | "global";
      id: string;
      detail: string;
    };

export type FormicEventType = FormicEvent["type"];

/** An event as it travels over the wire, with the replay cursor attached. */
export interface SequencedEvent {
  /** Monotonic per project. The client sends this back as Last-Event-ID. */
  seq: number;
  projectId: string;
  at: string;
  event: FormicEvent;
}
