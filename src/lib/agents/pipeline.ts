import "server-only";

import { randomUUID } from "node:crypto";

import { agents } from "./registry";
import type { AgentContext, AgentOutcome, Usage } from "./ports";
import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { beginRun, endRun, recordSpend } from "@/lib/budget/controller";
import { positionForIndex } from "@/lib/ordering";
import type { Prd } from "@/lib/domain/entities";

/**
 * Wires agents to column transitions.
 *
 * Each pipeline runs detached: the transition request returns as soon as the
 * card has moved, and progress reaches the client over the event stream. A
 * user should never watch a spinner while a model thinks.
 */

interface RunHandle {
  runId: string;
  ctx: AgentContext;
  finish: (outcome: AgentOutcome<unknown>) => Promise<void>;
}

function startRun(
  projectId: string,
  role: "product" | "architect" | "pm",
  ids: { epicId?: string | null; ticketId?: string | null },
): RunHandle {
  const runId = randomUUID();
  const signal = beginRun({
    runId,
    projectId,
    epicId: ids.epicId ?? null,
    ticketId: ids.ticketId ?? null,
  });

  const ctx: AgentContext = {
    runId,
    projectId,
    signal,
    emit: (event) => {
      // Fire and forget: an agent must not block on the event bus, and a
      // failed publish is not a reason to fail the run.
      void publish(projectId, event);
    },
  };

  const finish = async (outcome: AgentOutcome<unknown>) => {
    const usage: Usage = outcome.usage;
    await recordSpend(runId, {
      cents: usage.costCents,
      attempts: 1,
    });
    await publish(projectId, {
      type: "run.usage",
      runId,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costCents: usage.costCents,
    });
    await publish(projectId, {
      type: "run.finished",
      runId,
      status: outcome.ok ? "succeeded" : outcome.blocked ? "blocked" : "failed",
      error: outcome.ok ? null : outcome.error,
    });
    endRun(runId);
  };

  return { runId, ctx, finish };
}

/** Stage 2. Raw backlog request becomes an Epic PRD. */
export async function runProductAgent(
  projectId: string,
  epicId: string,
  rawRequest: string,
): Promise<void> {
  const { ctx, finish } = startRun(projectId, "product", { epicId });
  const repo = repository();

  const outcome = await agents().product.draftPrd(ctx, { epicId, rawRequest });

  if (outcome.ok) {
    await repo.setEpicPrd(epicId, outcome.value.prd, false);
    await publish(projectId, {
      type: "card.status",
      cardId: epicId,
      kind: "epic",
      status: "specified",
      stalledIn: null,
      stage: 2,
      blockedReason: null,
    });
  } else {
    await publish(projectId, {
      type: "card.status",
      cardId: epicId,
      kind: "epic",
      status: outcome.blocked ? "blocked" : "failed",
      stalledIn: "backlog",
      stage: 2,
      blockedReason: outcome.error,
    });
  }

  await finish(outcome);
}

/** Stage 3. Epic PRD becomes a validated DAG of child tickets. */
export async function runArchitectAgent(
  projectId: string,
  epicId: string,
  title: string,
  prd: Prd,
  repoTree: string[],
): Promise<void> {
  const { ctx, finish } = startRun(projectId, "architect", { epicId });
  const repo = repository();

  const outcome = await agents().architect.decompose(ctx, {
    epicId,
    title,
    prd,
    repoTree,
  });

  if (outcome.ok) {
    const positions = await repo.columnPositions(projectId, "todo");
    let cursor = positions.length;

    await repo.createTickets(
      outcome.value.map((t) => ({
        epicId,
        key: t.key,
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        fileScope: t.fileScope,
        size: t.size,
        position: positionForIndex(positions, cursor++),
        dependsOnKeys: t.dependsOn,
      })),
    );

    await publish(projectId, {
      type: "card.created",
      cardId: epicId,
      kind: "epic",
      epicId,
    });
  } else {
    await publish(projectId, {
      type: "card.status",
      cardId: epicId,
      kind: "epic",
      status: outcome.blocked ? "blocked" : "failed",
      stalledIn: "todo",
      stage: 3,
      blockedReason: outcome.error,
    });
  }

  await finish(outcome);
}

/**
 * Detached launcher. A rejected promise here must not become an unhandled
 * rejection that takes the server down.
 */
export function launch(work: () => Promise<void>, label: string): void {
  void work().catch((e) => {
    console.error(`[formic] ${label} failed:`, e);
  });
}
