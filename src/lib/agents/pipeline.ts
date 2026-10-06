import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { after } from "next/server";

import type {
  AgentAttachment,
  AgentContext,
  AgentOutcome,
  DraftTicket,
  ExistingTicket,
  Usage,
} from "./ports";
import { budgetTokens } from "./ports";
import { repository } from "@/lib/db";
import type { AttachmentRef } from "@/lib/db/repository";
import { publish } from "@/lib/events/bus";
import { ticketNotes } from "@/lib/coder/notes";
import { epicNoteTexts, withEpicNotes } from "./epic-notes";
import { beginRun, endRun, recordSpend } from "@/lib/budget/controller";
import { budgetFor, type Budget } from "@/lib/budget/budget-for";
import { attemptsFor } from "@/lib/budget/in-process";
import { positionForIndex } from "@/lib/ordering";
import type { AgentRole, Prd } from "@/lib/domain/entities";
import { agentFor, cliAgentFor, runTargetFor } from "./presets";
import { handoffSection } from "./handoff";
import { startCliAnswer, startCliDraftTicket } from "@/lib/runner/runner";
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
  ids: {
    epicId?: string | null;
    ticketId?: string | null;
    model?: string | null;
    /** Who bills for the model, so the spend ceiling knows if it is money. */
    provider?: string | null;
    /** The saved agent running it, so what it uses is counted to that agent. */
    presetId?: string | null;
    /** What the run is held to; unset is the in-process default for a one-point ticket. */
    budget?: Budget;
  },
): RunHandle {
  const runId = randomUUID();
  const budget = ids.budget ?? budgetFor(null, null, {}, "in-process");
  const signal = beginRun({
    runId,
    projectId,
    epicId: ids.epicId ?? null,
    ticketId: ids.ticketId ?? null,
    model: ids.model ?? null,
    provider: ids.provider ?? null,
    budget,
  });

  const record = {
    id: runId,
    role,
    epicId: ids.epicId ?? null,
    ticketId: ids.ticketId ?? null,
    model: ids.model ?? null,
    presetId: ids.presetId ?? null,
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
  let chargedTokens = 0;
  let planWrites: Promise<void> = Promise.resolve();

  const startedAt = new Date();
  const heard = new Set<number>();
  const ticketId = ids.ticketId ?? null;

  const ctx: AgentContext = {
    runId,
    projectId,
    signal,
    budget,
    startedAt: startedAt.getTime(),
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
      const tokens = budgetTokens(usage);
      charged = usage.costCents;
      chargedTokens += tokens;
      await recordSpend(runId, {
        cents: usage.costCents,
        tokens,
        attempts: 0,
      });
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
      tokens: Math.max(budgetTokens(usage) - chargedTokens, 0),
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
 * A Product or Architect Agent decided the request belongs in the other
 * column instead of doing what its own stage does: a Backlog request small
 * enough to skip the PRD becomes the one ticket it really is, in To Do; a To
 * Do request too big for one ticket goes back to Backlog for a PRD and a
 * real breakdown. Either way the move is recorded — where it came from, and
 * why — so the card explains itself rather than looking hand-moved.
 */
export async function applyReroute(
  projectId: string,
  input:
    | { from: "backlog"; epicId: string; reason: string; ticket: DraftTicket }
    | { from: "todo"; epicId: string; ticketId: string; reason: string },
): Promise<void> {
  const repo = repository();

  if (input.from === "backlog") {
    // The Epic becomes a holder only: its one ticket is the request now.
    await repo.setStandalone(input.epicId, true);
    const positions = await repo.columnPositions(projectId, "todo");
    const position = positionForIndex(positions, positions.length);
    const created = (
      await repo.createTickets([
        {
          epicId: input.epicId,
          key: input.ticket.key,
          title: input.ticket.title,
          description: input.ticket.description,
          acceptanceCriteria: input.ticket.acceptanceCriteria,
          fileScope: input.ticket.fileScope,
          size: input.ticket.size,
          storyPoints: input.ticket.storyPoints ?? null,
          needsHuman: input.ticket.needsHuman ?? null,
          position,
          dependsOnKeys: [],
        },
      ])
    )[0]!;
    await repo.move({
      cardId: created.id,
      kind: "ticket",
      status: "ready",
      stalledIn: null,
      position,
      detached: true,
    });
    await repo.setReroute(created.id, "ticket", { from: "backlog", reason: input.reason });

    await publish(projectId, { type: "card.deleted", cardId: input.epicId, kind: "epic", issueNumbers: [] });
    await publish(projectId, { type: "card.created", cardId: created.id, kind: "ticket", epicId: input.epicId });
    await publish(projectId, {
      type: "card.rerouted",
      cardId: created.id,
      kind: "ticket",
      from: "backlog",
      to: "todo",
      reason: input.reason,
    });
    return;
  }

  // The drafting placeholder was standing in for the request; the request is
  // the Epic now, back where a PRD and a real breakdown can be written for it.
  await repo.deleteTickets([input.ticketId]);
  await repo.setStandalone(input.epicId, false);
  const positions = await repo.columnPositions(projectId, "backlog");
  const position = positionForIndex(positions, positions.length);
  await repo.move({ cardId: input.epicId, kind: "epic", status: "draft", stalledIn: null, position });
  await repo.setReroute(input.epicId, "epic", { from: "todo", reason: input.reason });

  await publish(projectId, { type: "card.deleted", cardId: input.ticketId, kind: "ticket", issueNumbers: [] });
  await publish(projectId, { type: "card.created", cardId: input.epicId, kind: "epic", epicId: null });
  await publish(projectId, {
    type: "card.rerouted",
    cardId: input.epicId,
    kind: "epic",
    from: "todo",
    to: "backlog",
    reason: input.reason,
  });

  // Back in Backlog is only half of it: the Epic has no PRD, and nothing else
  // starts a Product Agent for one that arrives here. Without this the card
  // sits in Backlog with nothing writing its PRD — or, dragged back into To
  // Do, waits there on a PRD that is never coming (see needsPrd in
  // board/service.ts).
  //
  // This start is detached, like every other one the board makes, so it can be
  // lost the same way. Unlike the rest there is no sweep behind it — an Epic in
  // Backlog is parked, and waking parked ones up is not the board's business —
  // so the way back is the person's: into To Do, which starts an agent of its
  // own for an Epic no agent is on, or Retry in the drawer once the card has
  // gone quiet.
  const [epic, detail] = await Promise.all([repo.cardById(input.epicId), repo.epicDetail(input.epicId)]);
  if (!prdSchema.safeParse(detail?.prd).success) {
    launch(
      () => runProductAgent(projectId, input.epicId, detail?.rawRequest ?? epic?.title ?? ""),
      `product agent for ${epic?.key ?? "the Epic"}`,
    );
  }
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

/**
 * Stage 3 from the Epic as saved: its PRD and the repository's layout, plus
 * whatever the person has asked of this breakdown and, when there is
 * anything to ask it about, the tickets that already exist under it.
 */
export async function decomposeEpic(projectId: string, epicId: string): Promise<void> {
  const detail = await repository().epicDetail(epicId);
  const prd = prdSchema.safeParse(detail?.prd);
  if (!detail || !prd.success) return;
  const tree = await repoTree(projectId);
  const instructions = await epicNoteTexts(projectId, epicId);
  const existing = instructions.length > 0 ? await existingTicketsFor(epicId) : undefined;
  await runArchitectAgent(projectId, epicId, detail.title, prd.data, tree, { instructions, existing });
}

/** An Epic's current tickets, as the Architect Agent sees them when asked to revise its own work. */
export async function existingTicketsFor(epicId: string): Promise<ExistingTicket[]> {
  const tickets = await repository().ticketsForEpic(epicId);
  return tickets.map((t) => ({
    key: t.key,
    title: t.title,
    description: t.description,
    acceptanceCriteria: t.acceptanceCriteria,
    fileScope: t.fileScope,
    storyPoints: t.storyPoints ?? undefined,
    inFlight: !unstarted(t),
  }));
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
  const kept = existing.filter((t) => !unstarted(t));
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
  const taken = new Set(kept.map((t) => t.key));
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
      needsHuman: t.needsHuman ?? null,
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

  // A record of what a re-decomposition changed: it deletes tickets outright,
  // so this is the only trace of what they were, kept where a person already
  // reads the Epic's chat.
  if (existing.length > 0 && replaced.length > 0) {
    await repo.addCardChatMessage({
      projectId,
      cardKind: "epic",
      cardId: epicId,
      role: "assistant",
      content: [
        `Broke it down again. Replaced ${replaced.map((t) => `${t.key} (${t.title})`).join(", ")}.`,
        kept.length > 0
          ? `Kept ${kept.map((t) => t.key).join(", ")}, already in flight.`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
      status: "done",
    });
  }
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

/**
 * A card's attachments, read back and shaped for a model: an image as base64,
 * a text file as its decoded content. One whose bytes are gone is dropped, not
 * failed — a pruned attachment is not a reason to stop drafting.
 *
 * The CLI agents get the same files by URL instead (`attachmentsPrompt` in
 * runner.ts): they run in GitHub Actions and can download them there, while an
 * in-process agent has to be handed the bytes.
 */
async function attachmentsFor(ref: AttachmentRef): Promise<AgentAttachment[]> {
  const repo = repository();
  const summaries = await repo.attachmentsFor(ref);
  const attachments = await Promise.all(
    summaries.map(async (s): Promise<AgentAttachment | null> => {
      const content = await repo.attachmentContent(s.id);
      if (!content) return null;
      const base = { id: s.id, filename: s.filename, mimeType: s.mimeType };
      return s.kind === "image"
        ? { ...base, kind: "image" as const, base64: Buffer.from(content.bytes).toString("base64") }
        : { ...base, kind: "file" as const, text: Buffer.from(content.bytes).toString("utf-8") };
    }),
  );
  return attachments.filter((a): a is AgentAttachment => a !== null);
}

/** Stage 2. Raw backlog request becomes an Epic PRD. */
export async function runProductAgent(
  projectId: string,
  epicId: string,
  rawRequest: string,
): Promise<void> {
  const run = startRun(projectId, "product", {
    epicId,
    ...(await runTargetFor(projectId, "product")),
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
    rawRequest: withEpicNotes(rawRequest, await epicNoteTexts(projectId, epicId)),
    attachments: await attachmentsFor({ epicId }),
  });

  if (outcome.ok) {
    if (outcome.value.kind === "prd") {
      await applyPrd(projectId, epicId, outcome.value.prd);
    } else {
      await applyReroute(projectId, {
        from: "backlog",
        epicId,
        reason: outcome.value.reason,
        ticket: outcome.value.ticket,
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
  guidance?: { instructions: string[]; existing?: ExistingTicket[] },
): Promise<void> {
  const run = startRun(projectId, "architect", {
    epicId,
    ...(await runTargetFor(projectId, "architect")),
  });

  const cli = await cliAgentFor(projectId, "todo");
  if (cli) {
    // A CLI agent builds its own prompt straight from the Epic and its
    // notes when it runs (see answerPrompt in the runner), so it needs
    // nothing passed through here.
    await startCliAnswer({ projectId, epicId, mode: "architect", agent: cli, run });
    return;
  }

  const outcome = await (await agentFor(projectId, "architect")).decompose(run.ctx, {
    epicId,
    title,
    prd,
    repoTree,
    existing: guidance?.existing,
    instructions: guidance?.instructions,
    maxAttempts: await attemptsFor((await projectFor(projectId)).ownerId, "decomposition"),
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
    ...(await runTargetFor(projectId, "architect")),
  });

  const cli = await cliAgentFor(projectId, "todo");
  if (cli) {
    // A CLI agent drafts it in GitHub Actions and the answer comes back on
    // the workflow_run webhook (see startCliDraftTicket in the runner).
    await startCliDraftTicket({ projectId, ticketId, agent: cli, run });
    return;
  }

  const outcome = await (await agentFor(projectId, "architect")).draftTicket(run.ctx, {
    rawRequest,
    repoTree,
    attachments: await attachmentsFor({ ticketId }),
  });

  if (outcome.ok) {
    if (outcome.value.kind === "ticket") {
      await applyDraftedTicket(projectId, epicId, ticketId, outcome.value.ticket);
    } else {
      await applyReroute(projectId, { from: "todo", epicId, ticketId, reason: outcome.value.reason });
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
export async function applyDraftedTicket(
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
export async function stallDraftingTicket(
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

const streaming = new AsyncLocalStorage<true>();

/**
 * Runs work from inside a long-lived streaming response, such as the event
 * stream. `after()` there waits for the stream to end, which is usually the
 * platform cutting the function off, so anything launched would never start.
 * Launched from here, it starts at once instead, while the stream keeps the
 * function alive.
 */
export function fromStream<T>(work: () => T): T {
  return streaming.run(true, work);
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

  if (streaming.getStore()) {
    void run();
    return;
  }
  try {
    after(run);
  } catch {
    void run();
  }
}
