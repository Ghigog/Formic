import { AGENT_ROLES, type PlanStep } from "./entities";

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
      /** A person deleted an Epic, and every ticket under it with it. */
      type: "card.deleted";
      cardId: string;
      kind: "epic";
      /** The GitHub issues that tracked it and its tickets, to close. */
      issueNumbers: number[];
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
      /** What an agent thought or said between its actions on a ticket. */
      type: "run.thought";
      runId: string;
      ticketId: string | null;
      kind: "thinking" | "text";
      text: string;
    }
  | {
      /** The plan an agent is working a ticket through, as it stands now. */
      type: "ticket.plan";
      ticketId: string;
      steps: PlanStep[];
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
      /** A saved agent ran out of usage on its plan, or got it back. */
      type: "agent.limited";
      presetId: string;
      /** ISO time it can work again; null when it can now. */
      until: string | null;
      note: string | null;
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
