import "server-only";

import {
  type Budget,
  type Spend,
  DEFAULT_EPIC_BUDGET,
  DEFAULT_RUN_BUDGET,
  ZERO_SPEND,
  addSpend,
  checkBudget,
} from "./limits";
import { publish } from "@/lib/events/bus";
import { disposeAllSandboxes } from "@/lib/sandbox";

/**
 * Live run registry and the global stop.
 *
 * Every agent run registers here and receives an AbortSignal. The signal fires
 * when the run exceeds its budget, when its Epic exceeds the aggregate budget,
 * or when a human hits stop. Agents are expected to check it; sandboxes are
 * disposed by their own TTL regardless, so an agent that ignores the signal
 * still cannot run forever.
 */

interface LiveRun {
  runId: string;
  projectId: string;
  epicId: string | null;
  ticketId: string | null;
  controller: AbortController;
  budget: Budget;
  spend: Spend;
  startedAt: number;
}

declare global {
  var __formicRuns: Map<string, LiveRun> | undefined;
}

function runs(): Map<string, LiveRun> {
  if (!globalThis.__formicRuns) globalThis.__formicRuns = new Map();
  return globalThis.__formicRuns;
}

export function beginRun(input: {
  runId: string;
  projectId: string;
  epicId?: string | null;
  ticketId?: string | null;
  budget?: Budget;
}): AbortSignal {
  const controller = new AbortController();
  runs().set(input.runId, {
    runId: input.runId,
    projectId: input.projectId,
    epicId: input.epicId ?? null,
    ticketId: input.ticketId ?? null,
    controller,
    budget: input.budget ?? DEFAULT_RUN_BUDGET,
    spend: { ...ZERO_SPEND },
    startedAt: Date.now(),
  });
  return controller.signal;
}

export function endRun(runId: string): void {
  runs().delete(runId);
}

export function activeRunCount(projectId?: string): number {
  const all = [...runs().values()];
  return projectId ? all.filter((r) => r.projectId === projectId).length : all.length;
}

/**
 * Records spend and aborts the run if it, or its Epic, has hit a ceiling.
 * Returns false when the run was stopped.
 */
export async function recordSpend(
  runId: string,
  delta: Partial<Spend>,
): Promise<boolean> {
  const run = runs().get(runId);
  if (!run) return false;

  run.spend = addSpend(run.spend, delta);
  run.spend.elapsedMs = Date.now() - run.startedAt;

  const verdict = checkBudget(run.spend, run.budget);
  if (!verdict.ok) {
    await stopRun(runId, `Run budget: ${verdict.reason}`, "run");
    return false;
  }

  if (run.epicId) {
    const epicSpend = [...runs().values()]
      .filter((r) => r.epicId === run.epicId)
      .reduce((acc, r) => addSpend(acc, r.spend), { ...ZERO_SPEND });

    const epicVerdict = checkBudget(epicSpend, DEFAULT_EPIC_BUDGET);
    if (!epicVerdict.ok) {
      await stopEpic(run.epicId, `Epic budget: ${epicVerdict.reason}`);
      return false;
    }
  }

  return true;
}

export async function stopRun(
  runId: string,
  reason: string,
  scope: "run" | "epic" | "global" = "run",
): Promise<void> {
  const run = runs().get(runId);
  if (!run) return;

  run.controller.abort(new Error(reason));
  runs().delete(runId);

  await publish(run.projectId, {
    type: "budget.exhausted",
    scope,
    id: runId,
    detail: reason,
  });
  await publish(run.projectId, {
    type: "run.finished",
    runId,
    status: "blocked",
    error: reason,
  });
}

/**
 * A person stopped a ticket: aborts its runs in this process. The ticket's
 * own status says so to the runs in any other, which ask between turns.
 */
export function abortTicketRuns(ticketId: string, reason: string): void {
  for (const run of [...runs().values()].filter((r) => r.ticketId === ticketId)) {
    run.controller.abort(new Error(reason));
  }
}

export async function stopEpic(epicId: string, reason: string): Promise<void> {
  for (const run of [...runs().values()].filter((r) => r.epicId === epicId)) {
    await stopRun(run.runId, reason, "epic");
  }
}

/** The visible global stop. Halts every run and lets sandboxes dispose. */
export async function stopAll(
  projectId: string,
  reason = "Stopped by a human.",
): Promise<number> {
  const targets = [...runs().values()].filter((r) => r.projectId === projectId);
  for (const run of targets) {
    await stopRun(run.runId, reason, "global");
  }

  // Aborting a run asks the agent to stop. Disposing the sandboxes makes it
  // true regardless of whether the agent was listening.
  await disposeAllSandboxes(projectId);
  return targets.length;
}

export function spendFor(runId: string): Spend | null {
  return runs().get(runId)?.spend ?? null;
}
