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
import { disposeSandboxes } from "@/lib/sandbox";
import { repository } from "@/lib/db";

/**
 * Live run registry and the global stop.
 *
 * Every agent run registers here and receives an AbortSignal. The signal fires
 * when the run exceeds its budget, when its Epic exceeds the aggregate budget,
 * or when a human hits stop, for a run this process is driving. Sandboxes are
 * disposed by their own TTL regardless, so an agent that ignores the signal
 * still cannot run forever.
 *
 * On serverless a stop or a budget rarely lands in the same instance as the
 * run it is about to affect, so every stop is also written to the run's own
 * AgentRun row before anything local happens: cancelled, with why. A run's
 * `interrupts` (see src/lib/agents/pipeline.ts) polls that between turns, so
 * the instance actually driving it notices and aborts even though this
 * process's in-memory registry never held it. Spend is written the same way,
 * as it accrues, so an Epic's ceiling is checked against every run under it
 * from the database rather than only the ones live in this process.
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

  // Written on every call, not only at the end: an Epic's ceiling is read
  // from here, and a run that never finishes (crashed worker, still going
  // in another instance) must not make its Epic forget what it has spent.
  await repository()
    .recordRunSpend(runId, run.spend.cents)
    .catch((e) => console.error("[formic] could not persist run spend:", e));

  const verdict = checkBudget(run.spend, run.budget);
  if (!verdict.ok) {
    await stopRun(runId, `Run budget: ${verdict.reason}`, "run");
    return false;
  }

  if (run.epicId) {
    // Summed across every run under the Epic, database-side: finished runs
    // this process never saw, and runs a sibling instance is driving, both
    // count, not only what this process's own registry knows about.
    const epicCents = await repository()
      .epicSpentCents(run.epicId)
      .catch(() => run.spend.cents);

    const epicVerdict = checkBudget(
      { cents: epicCents, elapsedMs: 0, attempts: 0 },
      DEFAULT_EPIC_BUDGET,
    );
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

  await repository()
    .cancelRuns({ runId }, reason)
    .catch((e) => console.error("[formic] could not persist the stop:", e));

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
  // Durable first, so a sibling run this process never registered — another
  // instance is driving it — is cancelled too, not only the ones below.
  await repository()
    .cancelRuns({ epicId }, reason)
    .catch((e) => console.error("[formic] could not persist the epic stop:", e));

  for (const run of [...runs().values()].filter((r) => r.epicId === epicId)) {
    await stopRun(run.runId, reason, "epic");
  }
}

/** The visible global stop. Halts every run and disposes their sandboxes. */
export async function stopAll(
  projectId: string,
  reason = "Stopped by a human.",
  e2bApiKey?: string | null,
): Promise<number> {
  // The database, not this process's registry, says which runs are live:
  // "Stop all" is as likely to be pressed on the instance sitting idle as on
  // the one actually driving a run.
  const cancelled = await repository()
    .cancelRuns({ projectId }, reason)
    .catch((e) => {
      console.error("[formic] could not persist the stop:", e);
      return [] as Array<{ id: string; sandboxId: string | null }>;
    });

  for (const run of [...runs().values()].filter((r) => r.projectId === projectId)) {
    await stopRun(run.runId, reason, "global");
  }

  // Aborting asks the agent to stop; disposing the sandbox by the id the
  // database just gave us makes it true regardless of whether the instance
  // driving that run was listening, or was this one at all.
  const sandboxIds = cancelled
    .map((c) => c.sandboxId)
    .filter((id): id is string => id !== null);
  await disposeSandboxes(projectId, sandboxIds, e2bApiKey);

  return cancelled.length;
}

export function spendFor(runId: string): Spend | null {
  return runs().get(runId)?.spend ?? null;
}
