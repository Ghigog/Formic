import "server-only";

import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { normalizeScope, pathInScope, violationsInDiff } from "@/lib/domain/scope";
import { publish } from "@/lib/events/bus";
import { heldReason, widenClaim } from "@/lib/board/queue";
import { heldBy } from "@/lib/domain/queue";
import type { Reservation } from "@/lib/db/repository";
import { handoffFromSummary, withoutHandoff } from "@/lib/agents/handoff";
import { VcsError, mergeTarget, type VcsClient } from "@/lib/vcs";
import { projectFor } from "@/lib/board/project";

/**
 * When the right change needs files outside a ticket's scope.
 *
 * The scope is how tickets run side by side without writing the same files,
 * not a limit on how good a change may be. So an agent that needs more makes
 * the change anyway. Files nothing running is writing join its scope at once
 * (widenScope). Files a running ticket holds join it too, and the ticket
 * waits its turn in the queue (askForScope), its work kept on its own
 * branch; once they are free the kept work goes on to its pull request
 * without being done again. Nobody is asked.
 */

/** The files a ticket asked for that its scope does not cover yet. */
export function scopeAsked(ticket: Pick<TicketDetail, "scopeRequest" | "fileScope">): string[] {
  return ticket.scopeRequest.filter((p) => !pathInScope(p, ticket.fileScope));
}

/** What of a scope request a new file scope still leaves uncovered. */
export function stillAsked(scopeRequest: readonly string[], fileScope: readonly string[]): string[] {
  return scopeRequest.filter((p) => !pathInScope(p, fileScope));
}

/**
 * The scope now covers everything a ticket asked for: it is unblocked the
 * way answerScope(true) unblocks it, ready in To Do for the caller to move
 * on. `scopeRequest` is what settles the request: kept as it was when work
 * is waiting on the ticket's branch for the run that follows to pick up
 * (see hasKeptWork), emptied when nothing is kept and there is nothing left
 * to ask for.
 */
export async function resolveScopeRequest(
  projectId: string,
  ticket: TicketDetail,
  scopeRequest: readonly string[],
): Promise<void> {
  const repo = repository();
  await repo.updateTicket(ticket.id, {
    status: "ready",
    stalledIn: null,
    blockedReason: null,
    scopeRequest: [...scopeRequest],
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "ready",
    stalledIn: null,
    stage: ticket.stage,
    blockedReason: null,
  });
}

function listed(paths: string[]): string {
  const shown = paths.slice(0, 5).map((p) => `\`${p}\``).join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

/**
 * Takes files outside a ticket's scope into it when no running ticket is
 * writing them: the scope keeps parallel tickets apart, and with nothing
 * running there, there is nothing to keep apart. Returns the wider scope, or
 * null when a running ticket covers some of them and the person decides.
 */
export async function widenScope(
  projectId: string,
  ticket: TicketDetail,
  outside: string[],
): Promise<string[] | null> {
  const requested = normalizeScope(outside);
  const repo = repository();
  const fileScope = normalizeScope([...ticket.fileScope, ...requested]);
  // A scout widens its parent's claim with its own: the change it brings
  // back may become the parent's, and its siblings share the parent's files.
  const parent = ticket.scoutOf ? await repo.ticketDetail(ticket.scoutOf) : null;
  const together = parent ? [parent.id, ...(await repo.scoutsOf(parent.id)).map((s) => s.id)] : [];
  // Widening a running ticket's scope is a new claim on those files, held
  // against every board on the repository, and taken under the same lease
  // as any other start so nothing else claims them meanwhile.
  const widened = await widenClaim(
    projectId,
    { id: ticket.id, fileScope: requested },
    async () => {
      await repo.updateTicket(ticket.id, { fileScope });
      if (parent) await repo.updateTicket(parent.id, { fileScope: normalizeScope([...parent.fileScope, ...requested]) });
    },
    together,
  );
  if (!widened) return null;
  const text = `${ticket.key} needed files outside its scope, and no running ticket was using them, so I added them: ${listed(requested)}.`;
  await repo.addCardChatMessage({ projectId, cardKind: "ticket", cardId: ticket.id, role: "assistant", content: text });
  await publish(projectId, { type: "ticket.reply", ticketId: ticket.id, agent: "Coder Agent", text });
  return fileScope;
}

/**
 * The agent's work needs `outside`, and a running ticket is writing some of
 * those files. Nobody is asked: the files join the ticket's scope and it
 * waits in the queue, in In Progress, until nothing running uses them, then
 * carries on the way any queued ticket starts. `kept` says whether the work
 * is on the ticket's branch to carry on from (see hasKeptWork).
 */
export async function askForScope(
  projectId: string,
  ticket: TicketDetail,
  outside: string[],
  options: { kept: boolean },
): Promise<void> {
  const requested = normalizeScope(outside);
  // A scout does not wait: it is one scout fewer.
  if (ticket.scoutOf) {
    const { scoutReturned } = await import("./scouts");
    await scoutReturned(projectId, ticket, {
      ok: false,
      reason: `Needed files outside the ticket that another ticket is writing: ${listed(requested)}.`,
    });
    return;
  }
  const repo = repository();
  const fileScope = normalizeScope([...ticket.fileScope, ...requested]);
  const holder = await heldFiles(projectId, ticket, requested);
  const reason = holder
    ? heldReason(holder, projectId)
    : "Waiting for the files it added to its scope to be free. It starts on its own then.";
  // Kept work is what the next run picks up (hasKeptWork reads scopeRequest);
  // with nothing kept, the next run simply does the work in the wider scope.
  await repo.updateTicket(ticket.id, {
    status: "queued",
    stalledIn: null,
    fileScope,
    scopeRequest: options.kept ? requested : [],
    blockedReason: reason,
  });

  const text = [
    `${ticket.key} needed files outside its scope that ${holder ? holder.key : "another running ticket"} is writing, so I added them to its scope:`,
    "",
    ...requested.map((p) => `- \`${p}\``),
    "",
    options.kept
      ? "Its work is kept on its branch. It is queued and carries on from there as soon as those files are free."
      : "It is queued and does the work again as soon as those files are free.",
  ].join("\n");
  await repo.addCardChatMessage({ projectId, cardKind: "ticket", cardId: ticket.id, role: "assistant", content: text });
  await publish(projectId, { type: "ticket.reply", ticketId: ticket.id, agent: "Coder Agent", text });
  // Published last: a card that stops running moves the queue on (see the bus).
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "queued",
    stalledIn: null,
    stage: ticket.stage,
    blockedReason: reason,
  });
}

/**
 * Tickets left in To Do waiting for a person to allow files, from before
 * scope was granted on its own: granted now, and queued the same way.
 */
export async function grantAskedScope(projectId: string): Promise<void> {
  const repo = repository();
  for (const card of await repo.boardCards(projectId)) {
    if (card.kind !== "ticket" || card.status !== "blocked" || card.stalledIn !== "todo") continue;
    if (!card.blockedReason?.startsWith("Needs files outside its scope")) continue;
    const ticket = await repo.ticketDetail(card.id);
    const asked = ticket ? scopeAsked(ticket) : [];
    if (!ticket || asked.length === 0) continue;
    await askForScope(projectId, ticket, asked, { kept: hasKeptWork(ticket) });
  }
}

/** The running ticket holding some of `files`, other than this one and its scouts. */
async function heldFiles(projectId: string, ticket: TicketDetail, files: string[]): Promise<Reservation | null> {
  const repo = repository();
  const project = await repo.projectById(projectId);
  if (!project) return null;
  const together = (await repo.scoutsOf(ticket.id)).map((s) => s.id);
  return heldBy({ id: ticket.id, fileScope: files }, await repo.reservations(project.repoFullName), together);
}

/**
 * The person answered. Allowed, the scope takes the files; refused, the kept
 * work is dropped and the next run keeps to the scope. Either way the ticket
 * is ready in To Do again, and the caller moves it on.
 */
export async function answerScope(
  projectId: string,
  ticket: TicketDetail,
  allow: boolean,
): Promise<void> {
  const repo = repository();
  await repo.updateTicket(ticket.id, {
    status: "ready",
    stalledIn: null,
    blockedReason: null,
    ...(allow
      ? { fileScope: [...ticket.fileScope, ...ticket.scopeRequest] }
      : { scopeRequest: [], ...(ticket.prNumber ? {} : { branchName: null }) }),
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "ready",
    stalledIn: null,
    stage: ticket.stage,
    blockedReason: null,
  });
}

/** Work an earlier run kept on the ticket's branch while it asked for scope. */
export function hasKeptWork(ticket: TicketDetail): boolean {
  return ticket.scopeRequest.length > 0 && !!ticket.branchName && !ticket.prNumber;
}

/**
 * Carries kept work on to its pull request, now that the scope covers it.
 * Returns false when there turns out to be nothing kept, and the ticket
 * should simply be worked on again.
 */
export async function takeKeptWork(
  projectId: string,
  ticket: TicketDetail,
  client: VcsClient,
): Promise<boolean> {
  const repo = repository();
  const branch = ticket.branchName!;
  const project = await projectFor(projectId);
  // Only a branch that is gone means nothing was kept; any other failure
  // leaves the kept work where it is, to try again.
  // A stacked ticket's own work is what it adds to the branch it was built on.
  const change = await client
    .compare(ticket.stackedOn ?? mergeTarget(project.baseBranch), branch)
    .catch((e: unknown) => {
      if (e instanceof VcsError && e.status === 404) return null;
      throw e;
    });
  if (!change || change.files.length === 0) {
    await repo.updateTicket(ticket.id, { scopeRequest: [], branchName: null });
    return false;
  }

  const outside = violationsInDiff(change.files, ticket.fileScope);
  if (outside.length > 0 && !(await widenScope(projectId, ticket, outside))) {
    await askForScope(projectId, ticket, outside, { kept: true });
    return true;
  }

  await repo.updateTicket(ticket.id, { scopeRequest: [] });
  const message = change.messages.at(-1) ?? "";
  const [first, ...rest] = message.split("\n");
  const line = (first ?? "").trim();
  const { openTicketPullRequest } = await import("./pipeline");
  await openTicketPullRequest(projectId, ticket, client, {
    branch,
    change: {
      summary:
        (line.startsWith(`${ticket.key}:`) ? line.slice(ticket.key.length + 1).trim() : line) ||
        ticket.title,
      detail: withoutHandoff(rest.join("\n").trim()),
      verifiedWith: null,
      handoff: handoffFromSummary(message),
    },
  });
  return true;
}
