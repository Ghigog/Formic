import "server-only";

import { repository } from "@/lib/db";
import { branchProblem, openPmPullRequest, touchesWorkflows } from "@/lib/assistant/actions";
import { postPmMessage } from "@/lib/assistant/pm-messages";
import { branchHolder, lockBranch, pmHolder, PM_LOCK_MS, unlockBranch } from "@/lib/runner/branch-lock";
import type { VcsClient } from "@/lib/vcs";
import { BranchMovedError } from "@/lib/vcs/types";

/**
 * The PM's change, from the branch its job kept it on to the branch it
 * worked on (docs/plans/pm-chat.md, safety rows 1 and 4). Enforced here,
 * whatever the session was told:
 *
 * - never the base branch, never .github/workflows/, only a ticket's branch
 *   or the PM's own formic-pm/ branch (branchProblem);
 * - a ticket's branch only while no agent run holds it, under the branch
 *   lock, and only as a fast-forward: its history is never rewritten;
 * - anything else lands on a formic-pm/ branch of its own instead, so a
 *   change is never lost, and a pull request is opened for it.
 *
 * Every outcome is a notice in the chat.
 */

/** The PM's own branch for one turn's change. */
export function ownBranch(boardName: string, job: string): string {
  const slug = boardName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "board";
  const nonce = job.slice(job.lastIndexOf("--") + 2).replace(/[^A-Za-z0-9-]/g, "").slice(0, 16);
  return `formic-pm/${slug}-${nonce}`;
}

/** The head commit's subject, for a pull request's title. */
function titleOf(messages: string[]): string {
  const subject = [...messages].reverse().map((m) => m.split("\n")[0]!.trim()).find((m) => m && m !== "Changes from the board's assistant");
  return (subject ?? "Changes from the board's PM").slice(0, 120);
}

export interface Landed {
  branch: string;
  /** What the chat was told. */
  notice: string;
}

/**
 * Lands the commit `sha` from turn `job`. `wanted` is the branch the
 * session's checkout was on. Returns where it went, or null when it was
 * refused (and the chat says why).
 */
export async function landPmChange(input: {
  projectId: string;
  job: string;
  sha: string;
  wanted: string | null;
  client: VcsClient;
}): Promise<Landed | null> {
  const { projectId, job, sha, client } = input;
  const repo = repository();
  const project = await repo.projectById(projectId);
  if (!project) return null;
  const base = project.baseBranch;

  const tickets = (await repo.boardCards(projectId)).filter((c) => c.kind === "ticket" && !c.archived);
  const details = (await Promise.all(tickets.map((t) => repo.ticketDetail(t.id)))).flatMap((d) => (d ? [d] : []));
  const ticketOf = new Map(details.flatMap((d) => (d.branchName ? [[d.branchName, d] as const] : [])));

  const own = ownBranch(project.name, job);
  const wanted = input.wanted?.trim() ?? "";
  const named = wanted && wanted !== "HEAD" && !wanted.startsWith("formic-staging/") ? wanted : "";
  const problem = named ? branchProblem(named, { baseBranch: base, ticketBranches: new Set(ticketOf.keys()) }) : null;

  let target = named && !problem ? named : own;
  let why: string | null = named && problem ? problem : null;

  // What the turn changed, against where it lands.
  const from = target === own || !(await client.branchHead(target)) ? base : target;
  const change = await client.compare(from, sha);
  if (touchesWorkflows(change.files)) {
    const notice = "The PM's change touches .github/workflows/, which it may not change, so Formic did not push it.";
    await postPmMessage(projectId, { content: notice });
    return null;
  }
  if (change.files.length === 0) return null;

  const ticket = ticketOf.get(target);
  if (ticket) {
    const busy = ticket.status === "running" || !!ticket.runnerJob;
    const holder = busy ? null : await branchHolder(projectId, target);
    if (busy || (holder && !holder.startsWith("pm:"))) {
      why = `${ticket.key}'s agent is working on ${target}`;
      target = own;
    }
  }

  const moved = await moveUnderLock(projectId, target, job, sha, client);
  if (!moved && target !== own) {
    why = `${target} moved on while the PM worked, and Formic never rewrites a branch`;
    target = own;
    if (!(await moveUnderLock(projectId, own, job, sha, client))) return null;
  } else if (!moved) return null;

  const count = change.messages.length;
  const commits = `${count} commit${count === 1 ? "" : "s"}`;
  let notice: string;
  if (ticket && target !== own) {
    notice = `The PM pushed ${commits} to ${ticket.key}'s branch ${target}.`;
  } else {
    let pr = "";
    try {
      pr = ` ${await openPmPullRequest(projectId, {
        branch: target,
        title: titleOf(change.messages),
        body: change.messages.map((m) => `- ${m.split("\n")[0]}`).join("\n"),
      })}.`;
    } catch (e) {
      pr = ` Formic could not open its pull request: ${e instanceof Error ? e.message : String(e)}`;
    }
    notice = `The PM pushed ${commits} to ${target}${why ? ` (${why})` : ""}.${pr}`;
  }
  await postPmMessage(projectId, { content: notice });
  return { branch: target, notice };
}

/** A fast-forward of `branch` to `sha` while the PM holds its lock; false when it is held or the branch moved. */
async function moveUnderLock(projectId: string, branch: string, job: string, sha: string, client: VcsClient): Promise<boolean> {
  const holder = pmHolder(job);
  if (!(await lockBranch(projectId, branch, holder, PM_LOCK_MS))) return false;
  try {
    await client.moveBranch(branch, sha);
    return true;
  } catch (e) {
    if (e instanceof BranchMovedError) return false;
    throw e;
  } finally {
    await unlockBranch(projectId, branch, holder);
  }
}
