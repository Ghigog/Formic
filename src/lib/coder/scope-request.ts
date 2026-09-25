import "server-only";

import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { normalizeScope, pathInScope, violationsInDiff } from "@/lib/domain/scope";
import { publish } from "@/lib/events/bus";
import { handoffFromSummary, withoutHandoff } from "@/lib/agents/handoff";
import { VcsError, mergeTarget, type VcsClient } from "@/lib/vcs";
import { projectFor } from "@/lib/board/project";

/**
 * When the right change needs files outside a ticket's scope.
 *
 * The scope is how tickets run side by side without writing the same files,
 * not a limit on how good a change may be. So an agent that needs more makes
 * the change anyway, and Formic keeps its work on the ticket's own branch,
 * moves the ticket back to To Do and asks the person, in its chat, for the
 * extra files. Once they allow them, the ticket goes back to In Progress the
 * way any ticket does, once nothing running overlaps its wider scope, and the
 * kept work goes on to its pull request without being done again.
 */

/** The files a ticket asked for that its scope does not cover yet. */
export function scopeAsked(ticket: Pick<TicketDetail, "scopeRequest" | "fileScope">): string[] {
  return ticket.scopeRequest.filter((p) => !pathInScope(p, ticket.fileScope));
}

function listed(paths: string[]): string {
  const shown = paths.slice(0, 5).map((p) => `\`${p}\``).join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

/**
 * The agent's work needs `outside`: the ticket goes back to To Do and asks.
 * `kept` says whether the work is on the ticket's branch to carry on from.
 */
export async function askForScope(
  projectId: string,
  ticket: TicketDetail,
  outside: string[],
  options: { kept: boolean },
): Promise<void> {
  const requested = normalizeScope(outside);
  const reason = `Needs files outside its scope: ${listed(requested)}. Allow them in its chat to carry on.`;
  const repo = repository();
  await repo.updateTicket(ticket.id, {
    status: "blocked",
    stalledIn: "todo",
    scopeRequest: requested,
    blockedReason: reason,
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "blocked",
    stalledIn: "todo",
    stage: ticket.stage,
    blockedReason: reason,
  });

  const text = [
    `To do ${ticket.key} properly I needed files outside its scope (${ticket.fileScope.map((p) => `\`${p}\``).join(", ")}):`,
    "",
    ...requested.map((p) => `- \`${p}\``),
    "",
    options.kept
      ? "My work is kept on its branch. Say yes and I'll add them to its scope and carry on once nothing else running is using them. Say no and I'll start again within its scope."
      : "Say yes and I'll add them to its scope and do it again once nothing else running is using them. Say no and I'll do it within its scope.",
  ].join("\n");
  await repo.addCardChatMessage({ projectId, cardKind: "ticket", cardId: ticket.id, role: "assistant", content: text });
  await publish(projectId, { type: "ticket.reply", ticketId: ticket.id, agent: "Coder Agent", text });
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
  const change = await client
    .compare(mergeTarget(project.baseBranch), branch)
    .catch((e: unknown) => {
      if (e instanceof VcsError && e.status === 404) return null;
      throw e;
    });
  if (!change || change.files.length === 0) {
    await repo.updateTicket(ticket.id, { scopeRequest: [], branchName: null });
    return false;
  }

  const outside = violationsInDiff(change.files, ticket.fileScope);
  if (outside.length > 0) {
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
