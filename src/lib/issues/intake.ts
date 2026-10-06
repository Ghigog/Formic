import "server-only";

import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { createTodoItem } from "@/lib/board/service";
import { repository } from "@/lib/db";
import { vcs, type IssueSummary, type VcsClient } from "@/lib/vcs";
import { INTAKE_LABEL, isCardLabel } from "./labels";
import { inLane } from "./sync";

/**
 * GitHub issues as a way *in*.
 *
 * A person labels an issue `formic: intake` and Formic takes it from there:
 * one ticket on the board, drafted by the Architect Agent straight from the
 * issue's text, exactly as the board's own new-item dialog does
 * (`createTodoItem`) — an issue is already scoped, so it is not an Epic and
 * needs no PRD.
 *
 * Three decisions worth knowing:
 *
 * - **The label is the opt-in.** Importing every open issue would turn any
 *   repository into hundreds of cards on the first sweep, and would import
 *   Formic's own mirrored issues back in, filing issues about issues.
 * - **It is polled, not pushed.** On the local path — where Formic runs now —
 *   GitHub cannot reach `localhost`, so an `issues` webhook would silently do
 *   nothing on a laptop. The idle sweep is what makes this work at all; the
 *   webhook is an optimisation on top of it for a deployed board.
 * - **An imported issue is adopted, not duplicated.** The ticket records the
 *   issue it came from, and the mirror treats that as the issue it would have
 *   filed (see `ensureTicketIssue`), so the person's issue is the one their
 *   pull request says `Closes` and the one that closes.
 *
 * A GitHub failure here never fails the board: the sweep is a background
 * courtesy, and the next one tries again.
 */

/**
 * The issues to consider. A poll on a 30 s timer, so it stays cheap: one page,
 * open only, the label filter in the query, and `since` from the last listing
 * that worked. Nothing here reads more than the intake uses.
 */
async function list(client: VcsClient, repoFullName: string): Promise<IssueSummary[]> {
  const since = lastListed().get(repoFullName);
  // Taken before the request: an issue updated while it is in flight is then
  // still returned by the next `since`, rather than falling through the gap.
  const startedAt = new Date().toISOString();
  const issues = await client.issues("open", { labels: [INTAKE_LABEL], since });
  // Recorded only once it worked: a failed listing is retried in full.
  lastListed().set(repoFullName, startedAt);
  return issues;
}

/** The last listing that succeeded, per repository: what the next `since` reads. */
function lastListed(): Map<string, string> {
  const g = globalThis as { __formicIssueListedAt?: Map<string, string> };
  g.__formicIssueListedAt ??= new Map();
  return g.__formicIssueListedAt;
}

/** The issue as one request: what it is called, then what it says. */
function requestText(issue: IssueSummary): string {
  const title = issue.title.trim();
  const body = issue.body.trim();
  return body ? `${title}\n\n${body}` : title;
}

/** One issue, one key: however it was found, its import happens once. */
function deliveryKey(repoFullName: string, number: number): string {
  return `issue:${repoFullName}#${number}`;
}

async function importOne(
  projectId: string,
  repoFullName: string,
  issue: IssueSummary,
  /** Every issue number this project's mirror owns, read once per sweep. */
  mirrored: ReadonlySet<number>,
): Promise<void> {
  if (issue.state !== "open") return;
  // The label is the opt-in, and the whole reason a sweep is safe to run.
  if (!issue.labels.includes(INTAKE_LABEL)) return;
  // A label Formic wrote: a mirrored card, not a request. Covers the window
  // before its number is recorded here, and a mirror from another board.
  if (issue.labels.some(isCardLabel)) return;
  // Authoritative, and the reason nothing has to be trusted about labels: an
  // issue this project's mirror already owns is never filed back in.
  if (mirrored.has(issue.number)) return;

  const repo = repository();
  // Two sweeps, a sweep and a webhook, or two instances: one import.
  if (!(await repo.claimDelivery(deliveryKey(repoFullName, issue.number)))) return;

  await createTodoItem(projectId, requestText(issue), {
    sourceIssueNumber: issue.number,
  });
}

async function run(projectId: string, only?: number): Promise<void> {
  const project = await projectFor(projectId);
  if (project.id !== projectId) return;
  const creds = await credentialsForProject(project);
  // No token, no GitHub: there is nothing to read and asking would only be a
  // failure. The board runs without one, against the mock.
  if (!creds.githubToken) return;
  const client = vcs(project.repoFullName, creds.githubToken);

  await inLane(`intake:${projectId}`, async () => {
    // One page of what is labelled, or just the one the webhook named.
    const found =
      only === undefined
        ? await list(client, project.repoFullName)
        : [(await client.issue(only))].filter((i): i is IssueSummary => i !== null);
    // Nothing labelled: no need to ask the board anything at all.
    if (found.length === 0) return;

    const mirrored = new Set(await repository().mirroredIssueNumbers(projectId));
    for (const issue of found) {
      await importOne(projectId, project.repoFullName, issue, mirrored);
    }
  });
}

/** Errors already reported, so a lost Issues permission is said once, not per sweep. */
const reported = new Set<string>();

/**
 * Imports every issue a person has labelled as a way in, or just `only` when
 * the webhook named one. Never throws: the board is the source of truth, and a
 * repository without Issues access still runs.
 */
export async function importIssues(projectId: string, only?: number): Promise<void> {
  try {
    await run(projectId, only);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!reported.has(message)) {
      reported.add(message);
      console.warn(`[formic] could not import GitHub issues: ${message}`);
    }
  }
}
