import "server-only";

import { randomUUID } from "node:crypto";
import { after } from "next/server";

import type { AgentContext, AgentOutcome, DraftTicket, Usage } from "./ports";
import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { ticketNotes } from "@/lib/coder/notes";
import { beginRun, endRun, recordSpend } from "@/lib/budget/controller";
import { positionForIndex } from "@/lib/ordering";
import type { AgentRole, Prd } from "@/lib/domain/entities";
import { agentFor, cliAgentFor, modelFor } from "./presets";
import { handoffSection } from "./handoff";
import { startCliAnswer } from "@/lib/runner/runner";
import { prdSchema } from "@/lib/domain/entities";
import { unstarted } from "@/lib/domain/status";
import { projectFor } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";
import { directoryTree } from "@/lib/vcs/repositories";

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
  let planWrites: Promise<void> = Promise.resolve();

  const startedAt = new Date();
  const heard = new Set<number>();
  const ticketId = ids.ticketId ?? null;

  const ctx: AgentContext = {
    runId,
    projectId,
    signal,
    // Read from the database, not memory: the stop and the note may reach
    // another instance than the one running the agent.
    interrupts: ticketId
      ? async () => {
          const [ticket, cancelled] = await Promise.all([
            repository().ticketDetail(ticketId),
            // A "Stop all", or its Epic's budget, cancelled this run: both
            // are written durably, so the instance actually driving it sees
            // them here even though neither ever touched its own registry.
            repository().runCancelReason(runId),
          ]);
          const stopped =
            cancelled ??
            (ticket && (ticket.status === "blocked" || ticket.status === "failed")
              ? (ticket.blockedReason ?? "Stopped.")
              : null);
          const fresh = (await ticketNotes(projectId, ticketId, startedAt)).filter(
            (n) => !heard.has(n.seq),
          );
          for (const n of fresh) heard.add(n.seq);
          return { stopped, notes: fresh.map((n) => n.text) };
        }
      : undefined,
    emit: (raw) => {
      // A terminal line says which ticket it is for.
      const event = raw.type === "run.log" && !raw.ticketId && ticketId ? { ...raw, ticketId } : raw;
      // A plan is state, not only news: a ticket opened later shows it.
      // Written in order, so a quick succession of updates ends on the last.
      if (event.type === "ticket.plan") {
        const { ticketId, steps } = event;
        planWrites = planWrites
          .then(() => repository().updateTicket(ticketId, { plan: steps }))
          .catch((e) => console.error("[formic] could not save the plan:", e));
      }
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

/**
 * Stage 2 done: the PRD goes on the Epic.
 *
 * An Epic in To Do, whether waiting there for its PRD or already broken down
 * and having it edited, stays in To Do and goes straight to the Architect
 * Agent: its tickets are made, or made again from the new PRD, rather than
 * the Epic jumping back to Backlog and needing a second drag.
 */
export async function applyPrd(
  projectId: string,
  epicId: string,
  prd: Prd,
  byHuman = false,
): Promise<void> {
  const repo = repository();
  const before = await repo.cardById(epicId);
  const queued =
    before?.kind === "epic" &&
    !before.misplacedIn &&
    (before.status === "waiting" || before.status === "ready");

  await repo.setEpicPrd(epicId, prd, byHuman);

  if (queued) {
    await repo.move({
      cardId: epicId,
      kind: "epic",
      status: "ready",
      stalledIn: null,
      position: before.position,
    });
  }

  await publish(projectId, {
    type: "card.status",
    cardId: epicId,
    kind: "epic",
    status: queued ? "ready" : "specified",
    stalledIn: null,
    stage: 2,
    blockedReason: null,
  });

  if (queued) launch(() => decomposeEpic(projectId, epicId), `architect agent for ${before.key}`);
}

/**
 * Directories the Architect Agent uses to ground its file scopes: the picked
 * repository's real layout when GitHub can be read, and otherwise the known
 * layout of this repository, which is a better prompt than nothing.
 */
export async function repoTree(projectId: string): Promise<string[]> {
  const project = await projectFor(projectId);
  const { githubToken } = await credentialsForProject(project);
  const tree = githubToken
    ? await directoryTree(project.repoFullName, project.baseBranch, githubToken)
    : null;
  if (tree && tree.length > 0) return tree;
  return [
    "src/app",
    "src/components",
    "src/lib",
    "prisma",
    "docs",
    "scripts",
  ];
}

/** Stage 3 from the Epic as saved: its PRD and the repository's layout. */
export async function decomposeEpic(projectId: string, epicId: string): Promise<void> {
  const detail = await repository().epicDetail(epicId);
  const prd = prdSchema.safeParse(detail?.prd);
  if (!detail || !prd.success) return;
  const tree = await repoTree(projectId);
  await runArchitectAgent(projectId, epicId, detail.title, prd.data, tree);
}

/** Stage 3 done: the ticket graph goes on the board under its Epic. */
export async function applyTickets(
  projectId: string,
  epicId: string,
  tickets: DraftTicket[],
): Promise<void> {
  const repo = repository();

  // Broken down again: these replace the tickets no agent has started on.
  // Anything already in flight stays, and a new ticket that reuses one of
  // its keys is renamed so both can be told apart.
  const existing = await repo.ticketsForEpic(epicId);
  const replaced = existing.filter(unstarted);
  if (replaced.length > 0) {
    await repo.deleteTickets(replaced.map((t) => t.id));
    for (const t of replaced) {
      await publish(projectId, {
        type: "card.deleted",
        cardId: t.id,
        kind: "ticket",
        issueNumbers: t.issueNumber ? [t.issueNumber] : [],
      });
    }
  }
  const taken = new Set(existing.filter((t) => !unstarted(t)).map((t) => t.key));
  const keyFor = new Map<string, string>();
  for (const t of tickets) {
    let key = t.key;
    for (let n = 2; taken.has(key); n++) key = `${t.key}-${n}`;
    taken.add(key);
    keyFor.set(t.key, key);
  }

  const positions = await repo.columnPositions(projectId, "todo");
  let cursor = positions.length;

  await repo.createTickets(
    tickets.map((t) => ({
      epicId,
      key: keyFor.get(t.key)!,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      fileScope: t.fileScope,
      size: t.size,
      storyPoints: t.storyPoints ?? null,
      position: positionForIndex(positions, cursor++),
      dependsOnKeys: t.dependsOn.map((k) => keyFor.get(k) ?? k),
    })),
  );

  await publish(projectId, {
    type: "card.created",
    cardId: epicId,
    kind: "epic",
    epicId,
  });
}

/** Stage 8. The Epic's closing showcase, once every ticket has merged. */
export async function applyShowcase(
  projectId: string,
  epicId: string,
  markdown: string,
): Promise<void> {
  // What only the person can do comes first: it has to happen before the
  // walkthrough below it will work.
  const tickets = await repository().ticketsForEpic(epicId);
  const forYou = handoffSection(tickets.map((t) => ({ key: t.key, steps: t.handoff })));
  await repository().setEpicShowcase(epicId, forYou ? `${forYou}\n\n${markdown}` : markdown);
  await publish(projectId, {
    type: "card.status",
    cardId: epicId,
    kind: "epic",
    status: "merged",
    stalledIn: null,
    stage: 8,
    blockedReason: null,
  });
}

/** A planning stage could not finish. The Epic stays where it stopped. */
export async function stallEpic(
  projectId: string,
  epicId: string,
  error: string,
  options: { blocked: boolean; stalledIn: "backlog" | "todo"; stage: number },
): Promise<void> {
  const status = options.blocked ? "blocked" : "failed";
  // Saved, not only announced: a refresh must still show where it stopped.
  await repository().stallEpic(epicId, {
    status,
    stalledIn: options.stalledIn,
    stage: options.stage,
    reason: error,
  });
  await publish(projectId, {
    type: "card.status",
    cardId: epicId,
    kind: "epic",
    status,
    stalledIn: options.stalledIn,
    stage: options.stage,
    blockedReason: error,
  });
}

/** Stage 2. Raw backlog request becomes an Epic PRD. */
export async function runProductAgent(
  projectId: string,
  epicId: string,
  rawRequest: string,
): Promise<void> {
  const run = startRun(projectId, "product", {
    epicId,
    model: await modelFor(projectId, "product"),
  });

  // A CLI agent on the person's own plan answers from GitHub Actions, and
  // its answer arrives on the workflow_run webhook.
  const cli = await cliAgentFor(projectId, "backlog");
  if (cli) {
    await startCliAnswer({ projectId, epicId, mode: "product", agent: cli, run });
    return;
  }

  const outcome = await (await agentFor(projectId, "product")).draftPrd(run.ctx, {
    epicId,
    rawRequest,
    attachments: [],
  });

  if (outcome.ok) {
    if (outcome.value.kind === "prd") {
      await applyPrd(projectId, epicId, outcome.value.prd);
    } else {
      // Rerouting is not wired up yet; a reroute outcome just stalls the Epic.
      await stallEpic(projectId, epicId, outcome.value.reason, {
        blocked: true,
        stalledIn: "backlog",
        stage: 2,
      });
    }
  } else {
    await stallEpic(projectId, epicId, outcome.error, {
      blocked: outcome.blocked,
      stalledIn: "backlog",
      stage: 2,
    });
  }

  await run.finish(outcome);
}

/** Stage 3. Epic PRD becomes a validated DAG of child tickets. */
export async function runArchitectAgent(
  projectId: string,
  epicId: string,
  title: string,
  prd: Prd,
  repoTree: string[],
): Promise<void> {
  const run = startRun(projectId, "architect", {
    epicId,
    model: await modelFor(projectId, "architect"),
  });

  const cli = await cliAgentFor(projectId, "todo");
  if (cli) {
    await startCliAnswer({ projectId, epicId, mode: "architect", agent: cli, run });
    return;
  }

  const outcome = await (await agentFor(projectId, "architect")).decompose(run.ctx, {
    epicId,
    title,
    prd,
    repoTree,
  });

  if (outcome.ok) {
    await applyTickets(projectId, epicId, outcome.value);
  } else {
    await stallEpic(projectId, epicId, outcome.error, {
      blocked: outcome.blocked,
      stalledIn: "todo",
      stage: 3,
    });
  }

  await run.finish(outcome);
}

/**
 * Stage 3, one ticket. A To Do request has no PRD to break down: the
 * Architect Agent drafts the single ticket itself, straight from the raw
 * text, as thoroughly as one out of a DAG.
 */
export async function runArchitectDraftTicket(
  projectId: string,
  epicId: string,
  ticketId: string,
  rawRequest: string,
  repoTree: string[],
): Promise<void> {
  const run = startRun(projectId, "architect", {
    epicId,
    ticketId,
    model: await modelFor(projectId, "architect"),
  });

  // No AnswerMode covers drafting a single ticket yet, so a CLI agent on
  // this column cannot take the work; it fails the same way an unassigned
  // one does rather than hanging on an answer that will never arrive.
  const cli = await cliAgentFor(projectId, "todo");
  const outcome = cli
    ? {
        ok: false as const,
        blocked: true,
        error: `${cli.info.label} runs in GitHub Actions and cannot draft a single ticket yet. Pick another agent for To Do.`,
        usage: { model: cli.model ?? "", tokensIn: 0, tokensOut: 0, costCents: 0 },
      }
    : await (await agentFor(projectId, "architect")).draftTicket(run.ctx, {
        rawRequest,
        repoTree,
        attachments: [],
      });

  if (outcome.ok) {
    if (outcome.value.kind === "ticket") {
      await applyDraftedTicket(projectId, epicId, ticketId, outcome.value.ticket);
    } else {
      // Rerouting is not wired up yet; a reroute outcome just stalls the ticket.
      await stallDraftingTicket(projectId, ticketId, outcome.value.reason, true);
    }
  } else {
    await stallDraftingTicket(projectId, ticketId, outcome.error, outcome.blocked);
  }

  await run.finish(outcome);
}

/**
 * The drafted ticket replaces the placeholder in its same slot: no Epic
 * update is needed to have made this one, because it never had a PRD.
 */
async function applyDraftedTicket(
  projectId: string,
  epicId: string,
  ticketId: string,
  ticket: DraftTicket,
): Promise<void> {
  const repo = repository();
  const placeholder = await repo.cardById(ticketId);
  const position = placeholder?.position ?? 0;

  await repo.deleteTickets([ticketId]);
  const created = (
    await repo.createTickets([
      {
        epicId,
        key: ticket.key,
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: ticket.acceptanceCriteria,
        fileScope: ticket.fileScope,
        size: ticket.size,
        storyPoints: ticket.storyPoints ?? null,
        position,
        dependsOnKeys: [],
      },
    ])
  )[0]!;
  await repo.move({
    cardId: created.id,
    kind: "ticket",
    status: created.status,
    stalledIn: null,
    position,
    detached: true,
  });

  await publish(projectId, { type: "card.deleted", cardId: ticketId, kind: "ticket", issueNumbers: [] });
  await publish(projectId, { type: "card.created", cardId: created.id, kind: "ticket", epicId });
}

/** A drafting ticket's run could not finish. It stays in To Do, blocked or failed. */
async function stallDraftingTicket(
  projectId: string,
  ticketId: string,
  reason: string,
  blocked: boolean,
): Promise<void> {
  const status = blocked ? "blocked" : "failed";
  await repository().updateTicket(ticketId, { status, stalledIn: "todo", blockedReason: reason });
  await publish(projectId, {
    type: "card.status",
    cardId: ticketId,
    kind: "ticket",
    status,
    stalledIn: "todo",
    stage: 3,
    blockedReason: reason,
  });
}

/**
 * Detached launcher. A rejected promise here must not become an unhandled
 * rejection that takes the server down.
 *
 * Inside a request it goes through `after()`: on Vercel a function is frozen
 * once its response is sent, so plain fire-and-forget work silently stopped
 * mid-run. `after()` keeps the function alive until the work settles, up to
 * the function's max duration — the `maxDuration` declared on the route that
 * called this. DEFAULT_RUN_BUDGET (src/lib/budget/limits.ts) stays under that
 * ceiling on purpose: a run notices its own budget and stops cleanly, rather
 * than the platform cutting it off with no chance to report why. Outside a
 * request (tests, scripts) there is no such scope and `after()` throws, so it
 * runs detached as before.
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
