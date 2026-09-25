import "server-only";

import { z } from "zod";

import { decomposeEpic, launch, runProductAgent } from "./pipeline";
import { projectFor } from "@/lib/board/project";
import { applyTransition } from "@/lib/board/service";
import { credentialsForProject } from "@/lib/auth/credentials";
import { stopEpic } from "@/lib/budget/controller";
import { runCoderAgent } from "@/lib/coder/pipeline";
import { MAX_NOTE, addNote } from "@/lib/coder/notes";
import { answerScope, scopeAsked } from "@/lib/coder/scope-request";
import { repository } from "@/lib/db";
import { fileScopeSchema, prdSchema, type BoardCard } from "@/lib/domain/entities";
import { COLUMNS, COLUMN_LABELS, columnFor, columnOf, type ColumnId } from "@/lib/domain/status";
import { publish } from "@/lib/events/bus";
import { cancelJob, stopTicket } from "@/lib/runner/runner";
import { vcs } from "@/lib/vcs";

/**
 * What a column's agent can do to its card when the person asks in the
 * card's chat. The person talks to the agent; the agent acts. Each action
 * says what happened, in a line the person reads.
 */

export const cardActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    to: z.enum(COLUMNS).describe("The column to move the card to."),
  }),
  z.object({
    type: z.literal("close"),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe("Tickets only. What was done, or why nothing is needed, in one line."),
  }),
  z.object({
    type: z.literal("redo"),
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(MAX_NOTE)
      .describe("What the person wants this column's work to do now, in their terms."),
  }),
  z.object({ type: z.literal("stop") }),
  z.object({
    type: z.literal("edit_ticket"),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).optional().describe("The whole new description, in Markdown."),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).optional(),
    fileScope: fileScopeSchema.optional(),
    results: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("What the person reported doing or finding, added to the description under Results."),
  }),
  z.object({
    type: z.literal("widen_scope"),
    allow: z
      .boolean()
      .describe("True when the person lets the ticket have the files outside its scope it asked for, false when they say no."),
  }),
  z.object({
    type: z.literal("needs_human"),
    reason: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe("What the person has to do themselves, or null when an agent can do it after all."),
  }),
]);

export type CardAction = z.infer<typeof cardActionSchema>;

/** What each action is for, for the agent deciding what to do. */
export const CARD_ACTIONS_GUIDE = `What you can do, besides answering:
- move: move the card to another column, as dragging it would. Moving a ticket into In Progress starts the Coder Agent on it.
- close: tickets only. Put the ticket in Done without a pull request, with a one-line summary: for work the person did themselves, or work that is not needed after all. Whatever waits on it can go ahead.
- redo: start this column's work on the card again, doing what the person asks now (stopping any agent working it first). In Backlog it rewrites an Epic's PRD, in To Do it breaks an Epic down again, in In Progress it has the Coder Agent do what was asked, in In Review it has the Reviewer Agent review again. A ticket in To Do or Backlog has no work to redo: change the ticket with edit_ticket instead, or move it to In Progress to start it.
- stop: stop the agent working on the card.
- edit_ticket: tickets only. Rewrite the ticket's title, description, acceptance criteria or file scope, or add what the person reported doing or finding under Results.
- widen_scope: tickets only, when the ticket is asking for files outside its file scope. With allow true, the files join its scope and it goes back to In Progress, carrying on from its kept work, as soon as nothing running uses them. With allow false, its kept work is dropped and it starts again within its scope.
- needs_human: tickets only. Mark the ticket as work for the person, not an agent, with what they have to do; or null to hand it back to agents.

When to act:
- Act when the person asks for something, in whatever words. "This has already been done" asks you to close the ticket. "Yes", "go ahead" or "ok" to a ticket asking for files outside its scope is widen_scope with allow true; "no" is allow false. "Change it to use X" asks you to redo, or on a ticket nobody has started, to edit_ticket.
- Advice to take into account is already saved as a note that every run of this card reads, and any agent working it now reads it too. Do not redo for advice alone; say it will be taken into account.
- Do nothing the person did not ask for. When you are unsure what they want, ask.
- After acting, say in a line or two what you did. Never say you did something you did not.`;

const END = Number.MAX_SAFE_INTEGER;

/** Carries out an action on a card and says what happened. Never throws. */
export async function applyCardAction(
  projectId: string,
  cardKind: "epic" | "ticket",
  cardId: string,
  action: CardAction,
): Promise<string> {
  try {
    const card = await repository().cardById(cardId);
    if (!card) return "This card no longer exists.";
    switch (action.type) {
      case "move":
        return await move(projectId, card, action.to);
      case "close":
        return cardKind === "ticket"
          ? await close(projectId, card, action.summary)
          : "An Epic reaches Done when its tickets do; close its tickets instead.";
      case "redo":
        return cardKind === "ticket"
          ? await redoTicket(projectId, card, action.instruction)
          : await redoEpic(projectId, card);
      case "stop":
        return cardKind === "ticket" ? await stopWork(projectId, card) : await stopEpicWork(projectId, card);
      case "edit_ticket":
        return cardKind === "ticket" ? await edit(projectId, card, action) : "Only a ticket can be edited this way.";
      case "widen_scope":
        return cardKind === "ticket" ? await widenScope(projectId, card, action.allow) : "Only a ticket has a file scope.";
      case "needs_human":
        return cardKind === "ticket" ? await markNeedsHuman(projectId, card, action.reason) : "Only a ticket can be marked.";
    }
  } catch (e) {
    return `Could not ${action.type.replace("_", " ")}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function working(card: BoardCard): Promise<boolean> {
  if (card.status === "running" || card.workingSince) return true;
  const repo = repository();
  const job =
    card.kind === "ticket"
      ? (await repo.ticketDetail(card.id))?.runnerJob
      : (await repo.epicDetail(card.id))?.runnerJob;
  return !!job;
}

/**
 * Waits for a stopped ticket's run to end before starting another, so the
 * old one cannot stall the new one on its way out. A CLI agent's job is
 * forgotten the moment it is stopped; a built-in agent stops at its next turn.
 */
async function untilIdle(ticketId: string, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const card = await repository().cardById(ticketId);
    if (!card?.workingSince) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function move(projectId: string, card: BoardCard, to: ColumnId): Promise<string> {
  const from = columnOf(card);
  if (to === from) return `${card.key} is already in ${COLUMN_LABELS[to]}.`;
  if (card.kind === "ticket" && to === "done") {
    return close(projectId, card, "Done, as you said in its chat.");
  }

  // Moving it on is a new start: whatever was working on it stops first.
  if (card.kind === "ticket" && (await working(card))) {
    await stopTicket(projectId, card.id);
    await untilIdle(card.id);
  }
  const now = (await repository().cardById(card.id)) ?? card;
  const shown = columnOf(now);
  if (to === shown) return `${card.key} is in ${COLUMN_LABELS[to]}.`;

  const result = await applyTransition(projectId, {
    cardId: card.id,
    kind: card.kind,
    from: shown,
    to,
    position: END,
    actor: "agent",
  });
  if (!result.ok) return `Could not move ${card.key}: ${result.reason}`;
  if (result.problem) {
    // Somewhere it cannot work: a drag leaves it there to show why, but
    // asked in words, it stays where it was and the reason is the answer.
    await applyTransition(projectId, {
      cardId: card.id,
      kind: card.kind,
      from: to,
      to: shown,
      position: now.position,
      actor: "agent",
    });
    return `Could not move ${card.key}: ${result.problem.replace(/\s*Drag it back to [^.]+ to undo this\./, "")}`;
  }
  return `Moved ${card.key} to ${COLUMN_LABELS[to]}.${
    card.kind === "ticket" && to === "in_progress" ? " The Coder Agent is starting on it." : ""
  }`;
}

async function close(projectId: string, card: BoardCard, summary: string): Promise<string> {
  if (card.status === "merged") return `${card.key} is already in Done.`;
  if (await working(card)) await stopTicket(projectId, card.id);
  const ticket = await repository().ticketDetail(card.id);
  if (!ticket) return "This ticket no longer exists.";
  const { closeByPerson } = await import("@/lib/review/pipeline");
  await closeByPerson(projectId, ticket, summary);
  const pull = ticket.prNumber
    ? ` Its pull request #${ticket.prNumber} is still open on GitHub; close it there if it is not needed.`
    : "";
  return `Closed ${card.key}: it is in Done, and anything waiting on it can go ahead.${pull}`;
}

async function redoTicket(projectId: string, card: BoardCard, instruction: string): Promise<string> {
  const home = columnFor(card.status, card.stalledIn);
  if (home === "in_progress") {
    if (card.needsHuman) {
      return `${card.key} is marked as work for you: ${card.needsHuman} Clear that with needs_human first if an agent should do it.`;
    }
    if (await working(card)) await stopTicket(projectId, card.id);
    launch(async () => {
      await untilIdle(card.id);
      await repository().updateTicket(card.id, { attempts: 0 });
      await runCoderAgent(projectId, card.id, { instruction });
    }, `coder agent for ${card.key}, from its chat`);
    return `Starting the Coder Agent on ${card.key} again, to do what you asked.`;
  }

  if (home === "in_review") {
    if (!card.prNumber) return `${card.key} has no pull request to review.`;
    if (await working(card)) await stopTicket(projectId, card.id);
    const prNumber = card.prNumber;
    launch(async () => {
      await untilIdle(card.id);
      const repo = repository();
      await repo.updateTicket(card.id, {
        status: "review",
        stalledIn: null,
        blockedReason: null,
        reviewedSha: null,
        attempts: 0,
      });
      const ticket = await repo.ticketDetail(card.id);
      await publish(projectId, {
        type: "card.status",
        cardId: card.id,
        kind: "ticket",
        status: "review",
        stalledIn: null,
        stage: ticket?.stage ?? card.stage,
        blockedReason: null,
      });
      const project = await projectFor(projectId);
      const creds = await credentialsForProject(project);
      const pull = await vcs(project.repoFullName, creds.githubToken).pullRequest(prNumber);
      const { reviewPullRequest } = await import("@/lib/review/pipeline");
      await reviewPullRequest(projectId, prNumber, pull.headSha);
    }, `review for ${card.key}, from its chat`);
    return `The Reviewer Agent is looking at ${card.key} again, with what you asked. It starts once CI has a result.`;
  }

  if (home === "done") return `${card.key} is done. Move it back to To Do, then In Progress, to work on it again.`;
  return `Nothing has been built for ${card.key} yet. Change the ticket with edit_ticket, or move it to In Progress to start it.`;
}

async function redoEpic(projectId: string, card: BoardCard): Promise<string> {
  const repo = repository();
  const home = columnFor(card.status, card.stalledIn);
  const detail = await repo.epicDetail(card.id);
  if (!detail) return "This Epic no longer exists.";
  // What the person said is already one of the Epic's notes, which both
  // agents are briefed with.
  if (home === "backlog") {
    if (await working(card)) return "The Product Agent is already writing this PRD. It reads what you said.";
    await repo.setEpicRunnerJob(card.id, null);
    launch(
      () => runProductAgent(projectId, card.id, detail.rawRequest),
      `product agent for ${card.key}, from its chat`,
    );
    return "Writing the PRD again, with what you said.";
  }
  if (home === "todo") {
    if (!prdSchema.safeParse(detail.prd).success) return "This Epic has no PRD to break down yet.";
    if (await working(card)) return "The Architect Agent is already breaking this Epic down. It reads what you said.";
    launch(() => decomposeEpic(projectId, card.id), `architect agent for ${card.key}, from its chat`);
    return "Breaking it down again with what you said. Tickets already started stay; the rest follow it.";
  }
  return `There is nothing to redo on an Epic in ${COLUMN_LABELS[home]}; its tickets carry the work.`;
}

async function stopWork(projectId: string, card: BoardCard): Promise<string> {
  return (await stopTicket(projectId, card.id))
    ? `Stopped the agent working on ${card.key}.`
    : `Nothing is working on ${card.key} right now.`;
}

async function stopEpicWork(projectId: string, card: BoardCard): Promise<string> {
  const repo = repository();
  const detail = await repo.epicDetail(card.id);
  if (!(await working(card))) return `Nothing is working on ${card.key} right now.`;
  if (detail?.runnerJob) {
    await repo.setEpicRunnerJob(card.id, null);
    await cancelJob(projectId, detail.runnerJob);
  }
  await stopEpic(card.id, "Stopped by you.");
  return `Stopped the agent working on ${card.key}.`;
}

async function edit(
  projectId: string,
  card: BoardCard,
  action: Extract<CardAction, { type: "edit_ticket" }>,
): Promise<string> {
  const repo = repository();
  const ticket = await repo.ticketDetail(card.id);
  if (!ticket) return "This ticket no longer exists.";

  const changed: string[] = [];
  let description = action.description ?? ticket.description;
  if (action.description) changed.push("description");
  if (action.results) {
    description = `${description.trimEnd()}\n\n### Results\n${action.results}`;
    changed.push("results");
  }
  if (action.title) changed.push("title");
  if (action.acceptanceCriteria) changed.push("acceptance criteria");
  if (action.fileScope) changed.push("file scope");
  if (changed.length === 0) return "Nothing to change.";

  await repo.updateTicket(card.id, {
    ...(action.title ? { title: action.title } : {}),
    ...(description !== ticket.description ? { description } : {}),
    ...(action.acceptanceCriteria ? { acceptanceCriteria: action.acceptanceCriteria } : {}),
    ...(action.fileScope ? { fileScope: action.fileScope } : {}),
  });
  await publish(projectId, { type: "card.created", cardId: card.id, kind: "ticket", epicId: card.epicId });
  return `Updated ${card.key}'s ${list(changed)}.`;
}

async function widenScope(projectId: string, card: BoardCard, allow: boolean): Promise<string> {
  const ticket = await repository().ticketDetail(card.id);
  if (!ticket) return "This ticket no longer exists.";
  const asked = scopeAsked(ticket);
  if (asked.length === 0) return `${card.key} is not asking for any files outside its scope.`;
  await answerScope(projectId, ticket, allow);
  if (!allow) {
    await addNote(projectId, card.id, `Keep this change inside the file scope (${ticket.fileScope.join(", ")}).`);
  }
  const done = allow
    ? `Added ${asked.map((p) => `\`${p}\``).join(", ")} to ${card.key}'s scope.`
    : `${card.key} keeps to its scope and starts again.`;
  // Back in To Do, it goes on the way any ticket does: only once nothing
  // running overlaps its scope.
  const moved = await move(projectId, (await repository().cardById(card.id)) ?? card, "in_progress");
  return moved.startsWith("Could not")
    ? `${done} It stays in To Do for now. ${moved.replace(/^Could not move [^:]+: /, "")}`
    : `${done} ${moved}`;
}

async function markNeedsHuman(projectId: string, card: BoardCard, reason: string | null): Promise<string> {
  await repository().updateTicket(card.id, { needsHuman: reason });
  await publish(projectId, { type: "card.created", cardId: card.id, kind: "ticket", epicId: card.epicId });
  return reason
    ? `Marked ${card.key} as work for you: ${reason}`
    : `${card.key} is back in agents' hands.`;
}

function list(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
