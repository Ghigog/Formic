import "server-only";

import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { prdSchema, type BoardCard } from "@/lib/domain/entities";
import type { FormicEvent } from "@/lib/domain/events";
import { COLUMN_LABELS, columnFor, isStalled, type ColumnId } from "@/lib/domain/status";
import { vcs, type VcsClient } from "@/lib/vcs";

/**
 * Every Epic and ticket, mirrored as a GitHub issue, so work can be followed
 * from GitHub as well as from the board.
 *
 * An Epic is a parent issue and its tickets are sub-issues. Each carries a
 * `formic:` label for the column it is in, and a comment marks the moments
 * worth a notification: work started, a pull request opened, a card that
 * needs a human, a merge. Merged tickets and shipped Epics are closed.
 *
 * This is the platform's job, not a prompt's: it happens the same way
 * whichever agent did the work, and costs no tokens. It is driven by the
 * card events the board already publishes, and a GitHub failure here never
 * fails the work it describes.
 */

const LABEL_PREFIX = "formic: ";
const BLOCKED_LABEL = `${LABEL_PREFIX}needs a human`;

const COLUMN_COLORS: Record<ColumnId, string> = {
  backlog: "c5c0b6",
  todo: "d9a441",
  in_progress: "e8a88a",
  in_review: "d4622a",
  done: "3f8f5a",
};

function columnLabel(column: ColumnId): string {
  return `${LABEL_PREFIX}${COLUMN_LABELS[column].toLowerCase()}`;
}

const FOOTER = "_Tracked by [Formic](https://formic-board.vercel.app). It moves with the board._";

/** One sync at a time per card, so two quick events cannot file two issues. */
function lanes(): Map<string, Promise<void>> {
  const g = globalThis as { __formicIssueLanes?: Map<string, Promise<void>> };
  g.__formicIssueLanes ??= new Map();
  return g.__formicIssueLanes;
}

function inLane(key: string, work: () => Promise<void>): Promise<void> {
  const previous = lanes().get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  lanes().set(key, next);
  return next.finally(() => {
    if (lanes().get(key) === next) lanes().delete(key);
  });
}

/** Labels are created once per repository per process. */
function labelsMade(): Set<string> {
  const g = globalThis as { __formicIssueLabels?: Set<string> };
  g.__formicIssueLabels ??= new Set();
  return g.__formicIssueLabels;
}

async function ensureLabels(client: VcsClient, repoFullName: string): Promise<void> {
  if (labelsMade().has(repoFullName)) return;
  for (const column of Object.keys(COLUMN_COLORS) as ColumnId[]) {
    await client.ensureLabel(
      columnLabel(column),
      COLUMN_COLORS[column],
      `In Formic's ${COLUMN_LABELS[column]} column.`,
    );
  }
  await client.ensureLabel(BLOCKED_LABEL, "b60205", "Formic stopped this and is waiting for a person.");
  labelsMade().add(repoFullName);
}

function labelsFor(card: BoardCard): string[] {
  const labels = [columnLabel(columnFor(card.status, card.stalledIn))];
  if (isStalled(card.status)) labels.push(BLOCKED_LABEL);
  return labels;
}

function list(items: string[], checkbox = false): string {
  return items.map((i) => `- ${checkbox ? "[ ] " : ""}${i}`).join("\n");
}

async function epicBody(epicId: string): Promise<string> {
  const epic = (await repository().epicDetail(epicId))!;
  const prd = prdSchema.safeParse(epic.prd);
  const parts = ["> " + epic.rawRequest.trim().split("\n").join("\n> ")];
  if (prd.success) {
    const p = prd.data;
    parts.push(
      "## Summary",
      p.summary,
      "## Problem",
      p.problem,
      "## Scope",
      list(p.scope),
      ...(p.outOfScope.length ? ["## Out of scope", list(p.outOfScope)] : []),
      "## Success criteria",
      list(p.successCriteria, true),
    );
  } else {
    parts.push("_The Product Agent has not written the PRD yet._");
  }
  parts.push("---", `Tickets are filed as sub-issues of this one. ${FOOTER}`);
  return parts.join("\n\n");
}

async function ticketBody(ticket: TicketDetail, card: BoardCard): Promise<string> {
  const repo = repository();
  const deps: string[] = [];
  for (const id of card.dependsOn) {
    const dep = await repo.ticketDetail(id);
    if (dep) deps.push(dep.issueNumber ? `#${dep.issueNumber} (${dep.key})` : dep.key);
  }
  return [
    ticket.description,
    "## Acceptance criteria",
    list(ticket.acceptanceCriteria, true),
    "## File scope",
    ticket.fileScope.map((p) => `\`${p}\``).join(", "),
    ...(deps.length ? ["## Depends on", list(deps)] : []),
    "---",
    FOOTER,
  ].join("\n\n");
}

interface Context {
  client: VcsClient;
  repoFullName: string;
}

async function ensureEpicIssue(ctx: Context, epicId: string, card: BoardCard): Promise<number> {
  const repo = repository();
  const epic = await repo.epicDetail(epicId);
  if (epic?.issueNumber) return epic.issueNumber;
  const issue = await ctx.client.createIssue({
    title: card.title,
    body: await epicBody(epicId),
    labels: labelsFor(card),
  });
  await repo.setEpicIssue(epicId, issue.number);
  return issue.number;
}

async function ensureTicketIssue(
  ctx: Context,
  ticket: TicketDetail,
  card: BoardCard,
): Promise<{ number: number; created: boolean }> {
  if (ticket.issueNumber) return { number: ticket.issueNumber, created: false };
  const repo = repository();
  const issue = await ctx.client.createIssue({
    title: `${ticket.key}: ${ticket.title}`,
    body: await ticketBody(ticket, card),
    labels: labelsFor(card),
  });
  await repo.updateTicket(ticket.id, { issueNumber: issue.number });

  const epicCard = await repo.cardById(ticket.epicId);
  if (epicCard) {
    const parent = await inLane(`epic:${ticket.epicId}`, async () => {
      await ensureEpicIssue(ctx, ticket.epicId, epicCard);
    }).then(async () => (await repo.epicDetail(ticket.epicId))?.issueNumber ?? null);
    if (parent) {
      // Sub-issues are newer than issues; without them the link is a line.
      await ctx.client.addSubIssue(parent, issue.id).catch(() =>
        ctx.client.comment(issue.number, `Part of #${parent}.`),
      );
    }
  }
  return { number: issue.number, created: true };
}

/** A comment for the moments worth a notification, or null. */
function ticketNote(event: FormicEvent & { type: "card.status" }, ticket: TicketDetail): string | null {
  switch (event.status) {
    case "running":
      return "An agent started work on this.";
    case "review":
      return ticket.prNumber ? `Pull request opened: #${ticket.prNumber}. CI and the merge are next.` : null;
    case "merged":
      return ticket.prNumber ? `Merged in #${ticket.prNumber}.` : "Merged.";
    case "blocked":
    case "failed":
      return `Stopped, and waiting for a person: ${event.blockedReason ?? "no reason given."}`;
    default:
      return null;
  }
}

function epicNote(event: FormicEvent & { type: "card.status" }): string | null {
  switch (event.status) {
    case "specified":
      return "The PRD is written. It is in the description above.";
    case "merged":
      return "Every ticket has merged. This Epic has shipped.";
    case "blocked":
    case "failed":
      return `Stopped, and waiting for a person: ${event.blockedReason ?? "no reason given."}`;
    default:
      return null;
  }
}

async function syncTicket(
  ctx: Context,
  ticketId: string,
  event?: FormicEvent & { type: "card.status" },
  /** The ticket itself changed, say its agent rewrote it: so does its issue. */
  rewritten = false,
) {
  const repo = repository();
  await inLane(`ticket:${ticketId}`, async () => {
    const ticket = await repo.ticketDetail(ticketId);
    const card = await repo.cardById(ticketId);
    if (!ticket || !card) return;

    const { number, created } = await ensureTicketIssue(ctx, ticket, card);
    if (!created) {
      await ctx.client.updateIssue(number, {
        labels: labelsFor(card),
        state: card.status === "merged" ? "closed" : "open",
        ...(rewritten ? { title: `${ticket.key}: ${ticket.title}`, body: await ticketBody(ticket, card) } : {}),
      });
    } else if (card.status === "merged") {
      await ctx.client.updateIssue(number, { state: "closed" });
    }
    const note = event ? ticketNote(event, ticket) : null;
    if (note) await ctx.client.comment(number, note);
  });
}

async function syncEpic(ctx: Context, epicId: string, event?: FormicEvent & { type: "card.status" }) {
  const repo = repository();
  await inLane(`epic:${epicId}`, async () => {
    const card = await repo.cardById(epicId);
    if (!card) return;
    const existing = (await repo.epicDetail(epicId))?.issueNumber ?? null;
    const number = await ensureEpicIssue(ctx, epicId, card);
    if (existing) {
      await ctx.client.updateIssue(number, {
        labels: labelsFor(card),
        state: card.status === "merged" ? "closed" : "open",
        // The PRD lands in the description the moment it exists.
        ...(event?.status === "specified" ? { body: await epicBody(epicId) } : {}),
      });
    }
    const note = event ? epicNote(event) : null;
    if (note) await ctx.client.comment(number, note);
  });
}

async function sync(projectId: string, event: FormicEvent): Promise<void> {
  if (event.type !== "card.status" && event.type !== "card.created" && event.type !== "card.deleted") {
    return;
  }

  const project = await projectFor(projectId);
  if (project.id !== projectId) return;
  const creds = await credentialsForProject(project);
  const ctx: Context = {
    client: vcs(project.repoFullName, creds.githubToken),
    repoFullName: project.repoFullName,
  };

  // Deleted on the board: its issues close as not planned, rather than
  // staying open for work that is no longer coming.
  if (event.type === "card.deleted") {
    for (const number of event.issueNumbers) {
      await ctx.client.updateIssue(number, { state: "closed", state_reason: "not_planned" });
    }
    return;
  }

  await ensureLabels(ctx.client, ctx.repoFullName);

  if (event.type === "card.status") {
    if (event.kind === "epic") await syncEpic(ctx, event.cardId, event);
    else await syncTicket(ctx, event.cardId, event);
    return;
  }

  // An Epic created, or its tickets just laid out under it.
  if (event.kind === "epic") {
    await syncEpic(ctx, event.cardId);
    for (const ticket of await repository().ticketsForEpic(event.cardId)) {
      await syncTicket(ctx, ticket.id);
    }
  } else {
    await syncTicket(ctx, event.cardId, undefined, true);
  }
}

/** Errors already reported, so a missing permission is said once, not per card. */
const reported = new Set<string>();

/**
 * Mirrors a card event onto GitHub issues. Never throws: the board is the
 * source of truth, and a repository without Issues access still runs.
 */
export async function syncIssues(projectId: string, event: FormicEvent): Promise<void> {
  try {
    await sync(projectId, event);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!reported.has(message)) {
      reported.add(message);
      console.warn(`[formic] could not update GitHub issues: ${message}`);
    }
  }
}
