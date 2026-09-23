import "server-only";

import { randomUUID } from "node:crypto";
import { after } from "next/server";

import type { AgentContext, AgentOutcome, Usage } from "./ports";
import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { beginRun, endRun, recordSpend } from "@/lib/budget/controller";
import { positionForIndex } from "@/lib/ordering";
import type { AgentRole, Prd } from "@/lib/domain/entities";
import { agentFor, modelFor } from "./presets";

/**
 * Wires agents to column transitions.
 *
 * Each pipeline runs detached: the transition request returns as soon as the
 * card has moved, and progress reaches the client over the event stream. A
 * user should never watch a spinner while a model thinks.
 */

export interface RunHandle {
  runId: string;
  ctx: AgentContext;
  /** Records the sandbox this run owns, so a restart can find the orphan. */
  attachSandbox: (sandboxId: string) => Promise<void>;
  finish: (outcome: AgentOutcome<unknown>) => Promise<void>;
}

export function startRun(
  projectId: string,
  role: AgentRole,
  ids: { epicId?: string | null; ticketId?: string | null; model?: string | null },
): RunHandle {
  const runId = randomUUID();
  const signal = beginRun({
    runId,
    projectId,
    epicId: ids.epicId ?? null,
    ticketId: ids.ticketId ?? null,
  });

  const record = {
    id: runId,
    role,
    epicId: ids.epicId ?? null,
    ticketId: ids.ticketId ?? null,
    model: ids.model ?? null,
    sandboxId: null as string | null,
  };
  // Journalled so a restart can find the orphan; never awaited, because an
  // agent must not wait on a write, and never unhandled either.
  void repository()
    .startRun(record)
    .catch((e) => console.error("[formic] could not journal run:", e));

  // What has already been billed to the budget. An agent that loops charges
  // as it goes; finish() must then settle only the difference, or a run pays
  // for every turn twice and trips its own ceiling.
  let charged = 0;

  const ctx: AgentContext = {
    runId,
    projectId,
    signal,
    emit: (event) => {
      // Fire and forget: an agent must not block on the event bus, and a
      // failed publish is not a reason to fail the run.
      void publish(projectId, event);
    },
    charge: async (usage) => {
      charged = usage.costCents;
      await recordSpend(runId, { cents: usage.costCents, attempts: 0 });
    },
  };

  const attachSandbox = async (sandboxId: string) => {
    record.sandboxId = sandboxId;
    await repository().startRun(record);
  };

  const finish = async (outcome: AgentOutcome<unknown>) => {
    const usage: Usage = outcome.usage;
    await recordSpend(runId, {
      cents: Math.max(usage.costCents - charged, 0),
      attempts: 1,
    });
    await repository().finishRun(runId, {
      status: outcome.ok ? "succeeded" : outcome.blocked ? "blocked" : "failed",
      error: outcome.ok ? null : outcome.error,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costCents: usage.costCents,
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

  return { runId, ctx, attachSandbox, finish };
}

/** Stage 2. Raw backlog request becomes an Epic PRD. */
export async function runProductAgent(
  projectId: string,
  epicId: string,
  rawRequest: string,
): Promise<void> {
  const { ctx, finish } = startRun(projectId, "product", {
    epicId,
    model: await modelFor(projectId, "product"),
  });
  const repo = repository();

  const outcome = await (await agentFor(projectId, "product")).draftPrd(ctx, { epicId, rawRequest });

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
  const { ctx, finish } = startRun(projectId, "architect", {
    epicId,
    model: await modelFor(projectId, "architect"),
  });
  const repo = repository();

  const outcome = await (await agentFor(projectId, "architect")).decompose(ctx, {
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
 *
 * Inside a request it goes through `after()`: on Vercel a function is frozen
 * once its response is sent, so plain fire-and-forget work silently stopped
 * mid-run. `after()` keeps the function alive until the work settles, up to
 * the function's max duration. Outside a request (tests, scripts) there is
 * no such scope and `after()` throws, so it runs detached as before.
 */
export function launch(work: () => Promise<void>, label: string): void {
  const run = () =>
    work().catch((e) => {
      console.error(`[formic] ${label} failed:`, e);
    });

  try {
    after(run);
  } catch {
    void run();
  }
}
