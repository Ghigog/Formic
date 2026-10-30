import "server-only";

import { withCardActor } from "@/lib/auth/actor";
import { startRun, launch } from "@/lib/agents/pipeline";
import type { CoderTask } from "@/lib/agents/ports";
import { repository } from "@/lib/db";
import { projectFor } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";
import type { TicketDetail } from "@/lib/db/repository";
import { prdSchema } from "@/lib/domain/entities";
import type { Origin } from "@/lib/agents/origin";
import { violationsInDiff } from "@/lib/domain/scope";
import { publish } from "@/lib/events/bus";
import { recordFollowUps } from "@/lib/board/follow-ups";
import { runScouts, scoutReturned, scouting, ticketNoteTexts } from "./scouts";
import { sharedNoteLine, sharedNotesFor } from "./shared-notes";
import { newBranchName } from "@/lib/sandbox";
import { announceStack, releaseWaiting, restack, stackBase, ticketBelow } from "./stack";
import { mergeTarget, vcs } from "@/lib/vcs";
import {
  commitAndPush,
  ensureMergeTarget,
  openCheckout,
  prepareMergeTarget,
  pullRequestBody,
  pullRequestTitle,
} from "./checkout";
import { agentFor, cliAgentFor, loopAgentFor, runTargetFor } from "@/lib/agents/presets";
import type { CodeChange, Usage } from "@/lib/agents/ports";
import type { VcsClient } from "@/lib/vcs";
import { budgetForRun, inProcessBudget } from "@/lib/budget/in-process";
import {
  cliPrompt,
  loopPayload,
  loopRunnerReady,
  resumeBrief,
  startJobRun,
} from "@/lib/runner/runner";
import { guidedWorkspace } from "@/lib/sandbox/workspace";
import { askForScope, hasKeptWork, takeKeptWork, widenScope } from "./scope-request";

/**
 * PROT-06. A ticket in In Progress becomes a pull request.
 *
 * The shape of this function is the ticket's acceptance criteria in order:
 * take a sandbox, let the agent work, check the diff against the declared
 * file scope *before* anything is pushed, push, open the pull request, and
 * dispose the sandbox however it ends.
 */

/** Stage 5 is Code Run, stage 6 is PR Opened. See docs/tasks/README.md. */
const STAGE_CODE_RUN = 5;
const STAGE_PR_OPEN = 6;

export function taskFor(
  ticket: TicketDetail,
  notes: string[] = [],
  instruction?: string,
  /** What agents on the repository's other tickets shared, one line each. */
  sharedNotes: string[] = [],
  /** The request the ticket's Epic came from: see ticketOrigin. */
  origin?: Origin,
): CoderTask {
  return {
    ...(instruction ? { instruction } : {}),
    ...(origin ? { origin } : {}),
    ...(sharedNotes.length ? { sharedNotes } : {}),
    ticketId: ticket.id,
    key: ticket.key,
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
    fileScope: ticket.fileScope,
    workType: ticket.workType,
    storyPoints: ticket.storyPoints,
    notes,
  };
}

/** The request the ticket's Epic came from, in the person's own words, with the PRD's summary. */
export async function ticketOrigin(ticket: Pick<TicketDetail, "epicId">): Promise<Origin | undefined> {
  const epic = await repository().epicDetail(ticket.epicId);
  if (!epic?.rawRequest.trim()) return undefined;
  const prd = prdSchema.safeParse(epic.prd);
  return { epic: epic.title, request: epic.rawRequest, summary: prd.success ? prd.data.summary : null };
}

export async function stallTicket(
  projectId: string,
  ticket: TicketDetail,
  reason: string,
  options: {
    blocked: boolean;
    stalledIn: "in_progress" | "in_review";
    /** The stage it got to, which is rarely the stage it started from. */
    stage?: number;
  },
): Promise<void> {
  // A scout's failure is one scout fewer, not a card that stops.
  if (ticket.scoutOf) {
    await scoutReturned(projectId, ticket, { ok: false, reason });
    return;
  }
  const status = options.blocked ? "blocked" : "failed";
  const stage = options.stage ?? ticket.stage;

  // Closed while its agent was being stopped: the run that stopped does not
  // get to bring it back out of Done.
  const current = await repository().ticketDetail(ticket.id);
  if (current?.status === "merged") return;
  // Already stopped here for this reason, as when a sweep reviews a parked
  // ticket again: nothing changes, so nothing is announced.
  if (
    current?.status === status &&
    current.stalledIn === options.stalledIn &&
    current.stage === stage &&
    current.blockedReason === reason
  ) {
    return;
  }

  await repository().updateTicket(ticket.id, {
    status,
    stalledIn: options.stalledIn,
    stage,
    blockedReason: reason,
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status,
    stalledIn: options.stalledIn,
    stage,
    blockedReason: reason,
  });
}

/** The Coder Agent's run on a ticket, on the keys of whoever set it going. */
export async function runCoderAgent(
  projectId: string,
  ticketId: string,
  options: { instruction?: string } = {},
): Promise<void> {
  return withCardActor(ticketId, () => codeTicket(projectId, ticketId, options));
}

async function codeTicket(
  projectId: string,
  ticketId: string,
  /** What the person asked this run to do, from the ticket's chat. */
  options: { instruction?: string } = {},
): Promise<void> {
  const repo = repository();
  const found = await repo.ticketDetail(ticketId);
  if (!found) return;
  let ticket: TicketDetail = found;

  // A ticket with scouts sent does not code itself: its scouts do.
  if (scouting(ticket)) {
    await runScouts(projectId, ticket);
    return;
  }

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  // Its pull request was closed without merging: that attempt is over, and
  // this one starts from the current code on a branch of its own.
  if (ticket.prNumber) {
    const pull = await client.pullRequest(ticket.prNumber).catch(() => null);
    if (pull && pull.state === "closed" && !pull.merged) {
      await client.deleteCheckpoint(ticket.id).catch(() => undefined);
      const fresh = { prNumber: null, prUrl: null, branchName: null, reviewedSha: null };
      await repo.updateTicket(ticket.id, fresh);
      ticket = { ...ticket, ...fresh };
    }
  }

  // Work kept while it asked for more scope goes on from where it stopped,
  // rather than being done again.
  if (hasKeptWork(ticket)) {
    try {
      if (await takeKeptWork(projectId, ticket, client)) return;
    } catch (e) {
      await stallTicket(projectId, ticket, `Could not take the kept work: ${e instanceof Error ? e.message : String(e)}`, {
        blocked: false,
        stalledIn: "in_progress",
        stage: STAGE_CODE_RUN,
      });
      return;
    }
    ticket = (await repo.ticketDetail(ticket.id)) ?? ticket;
  } else if (ticket.scopeRequest.length > 0) {
    // Answered, with nothing kept to carry on from: this run is the answer.
    await repo.updateTicket(ticket.id, { scopeRequest: [] });
    ticket = { ...ticket, scopeRequest: [] };
  }

  // Sent back with its pull request still open: build on that branch, so
  // the work lands on the same pull request instead of replacing it.
  const continuing = !!ticket.prNumber && !!ticket.branchName;
  const branch = continuing ? ticket.branchName! : newBranchName(ticket.key);

  let startFrom = branch;
  if (!continuing) {
    const target = await prepareMergeTarget(client, project.baseBranch);
    if (!target.ok) {
      await stallTicket(projectId, ticket, target.reason, {
        blocked: true,
        stalledIn: "in_progress",
        stage: STAGE_CODE_RUN,
      });
      return;
    }
    // Stacked on a prerequisite whose pull request is still open: built on
    // its branch, so this ticket need not wait for that one to merge.
    const below = await stackBase(projectId, ticket);
    startFrom = below?.branch ?? target.branch;
    ticket = { ...ticket, stackedOn: below?.branch ?? null };
    await repo.updateTicket(ticket.id, { stackedOn: ticket.stackedOn });
    if (below) await announceStack(projectId, ticket, below, target.branch);
  }

  const run = startRun(projectId, "coder", {
    ...(await runTargetFor(projectId, "coder")),
    epicId: ticket.epicId,
    ticketId: ticket.id,
    budget: await inProcessBudget(project.ownerId, ticket),
  });

  await repo.updateTicket(ticket.id, {
    status: "running",
    stalledIn: null,
    stage: STAGE_CODE_RUN,
    branchName: branch,
    blockedReason: null,
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "running",
    stalledIn: null,
    stage: STAGE_CODE_RUN,
    blockedReason: null,
  });

  // What the agents on the repository's other tickets have shared lately:
  // the start of this run's view of them, whichever path it runs on.
  const shared = (await sharedNotesFor(projectId, ticket.id).catch(() => [])).map(sharedNoteLine);
  const origin = await ticketOrigin(ticket).catch(() => undefined);

  // A CLI agent on the person's own plan works in GitHub Actions instead of
  // a sandbox here, and reports back on the workflow_run webhook.
  const cli = await cliAgentFor(projectId, "in_progress");
  if (cli) {
    await startJobRun({
      budget: await budgetForRun(
        project.ownerId,
        ticket,
        "cli-job",
        (await repository().columnOverrides(projectId)).in_progress,
      ),
      projectId,
      ticket: { ...ticket, branchName: branch },
      mode: "implement",
      agent: cli,
      from: startFrom,
      prompt: cliPrompt(
        cli,
        "implement",
        ticket,
        undefined,
        await ticketNoteTexts(projectId, ticket),
        options.instruction,
        shared,
        origin,
      ),
      run,
      stalledIn: "in_progress",
      stage: STAGE_CODE_RUN,
    });
    return;
  }

  // An agent on an API key runs in the job too, when this repository's
  // workflow can run Formic's own loop: that is what gives it the ticket's
  // budget — the person's setting — instead of the four minutes a
  // request has before the platform ends it. A repository on an older
  // workflow, and a board that has never installed one (local mode), keeps
  // the in-process path below exactly as it was: no card changes behaviour
  // because a feature exists.
  //
  // The job runs Formic's own loop out of the repository's checkout: the setup
  // pull request installs the entry with the workflow (see ensureRunner). So a
  // loop run needs no address of this board's — a laptop included — only that
  // the repository has the pair, which is what `loopRunnerReady` answers. A
  // repository that has not got it runs in-process below, exactly as it did
  // before the loop existed, and the card says which limit stopped it.
  const loop = await loopAgentFor(projectId, "in_progress");
  if (loop && (await loopRunnerReady(client, project.baseBranch))) {
    const notes = await ticketNoteTexts(projectId, ticket);
    // Read once, here: a setting changed after this run starts is for the next.
    // A column's own values win over the person's rules.
    const budget = await budgetForRun(
      project.ownerId,
      ticket,
      "loop",
      (await repository().columnOverrides(projectId)).in_progress,
    );
    await startJobRun({
      projectId,
      ticket: { ...ticket, branchName: branch },
      mode: "loop",
      agent: loop,
      budget,
      from: startFrom,
      // Built here, serialized by the runner: a resumed run's notes go in as
      // notes, because this prompt is JSON and cannot have a paragraph added
      // to it.
      prompt: (resumed) =>
        JSON.stringify(
          loopPayload({
            runId: run.runId,
            projectId,
            ticket,
            repoFullName: project.repoFullName,
            baseBranch: project.baseBranch,
            provider: loop.info.id,
            model: loop.model,
            budget,
            notes: resumed ? [...notes, resumeBrief(resumed, ticket.plan)] : notes,
            sharedNotes: shared,
            ...(options.instruction ? { instruction: options.instruction } : {}),
            ...(origin ? { origin } : {}),
          }),
        ),
      run,
      stalledIn: "in_progress",
      stage: STAGE_CODE_RUN,
    });
    return;
  }

  const checkout = await openCheckout({
    projectId,
    repoFullName: project.repoFullName,
    fromBranch: startFrom,
    newBranch: continuing ? null : branch,
    ticket,
    ctx: run.ctx,
    githubToken: creds.githubToken,
    e2bKey: creds.e2bKey,
    e2bFallbackUserId: creds.e2bFallbackUserId,
  }).catch((e: unknown) => e as Error);

  if (checkout instanceof Error) {
    await stallTicket(projectId, ticket, `Could not open a sandbox: ${checkout.message}`, {
      blocked: false,
      stalledIn: "in_progress",
      stage: STAGE_CODE_RUN,
    });
    await run.finish({
      ok: false,
      error: checkout.message,
      blocked: false,
      usage: { model: "none", tokensIn: 0, tokensOut: 0, costCents: 0 },
    });
    return;
  }

  if (checkout.sandboxId) await run.attachSandbox(checkout.sandboxId);

  try {
    const outcome = await (await agentFor(projectId, "coder")).implement(run.ctx, {
      task: taskFor(ticket, await ticketNoteTexts(projectId, ticket), options.instruction, shared, origin),
      // The scope guides the agent rather than fencing it in: the right
      // change may need a file outside it, and the diff check below asks
      // the person before any of that goes further.
      workspace: guidedWorkspace(checkout.raw, ticket.fileScope),
    });

    if (!outcome.ok) {
      await stallTicket(projectId, ticket, outcome.error, {
        blocked: outcome.blocked,
        stalledIn: "in_progress",
        stage: STAGE_CODE_RUN,
      });
      await run.finish(outcome);
      return;
    }

    const changed = await checkout.raw.changedFiles();

    if (changed.length === 0 && outcome.value.alreadyDone) {
      const { closeAlreadyDone } = await import("@/lib/review/pipeline");
      await closeAlreadyDone(projectId, ticket, outcome.value);
      await run.finish(outcome);
      return;
    }

    if (changed.length === 0) {
      const said = (outcome.value.summary ?? "").trim();
      const reason = ["The agent changed nothing", said].filter(Boolean).join("\n");
      await stallTicket(projectId, ticket, reason, {
        blocked: false,
        stalledIn: "in_progress",
        stage: STAGE_CODE_RUN,
      });
      await run.finish({ ...outcome, ok: false, error: reason, blocked: false });
      return;
    }

    // The file scope check that makes concurrency safe, before anything
    // reaches a pull request. Work that needed more is kept on the ticket's
    // own branch, which no other ticket reads, while the person is asked
    // for the files. On a branch with an open pull request, pushing would
    // put it in front of the reviewer unasked, so it is not kept there.
    const violations = violationsInDiff(changed, ticket.fileScope);
    if (violations.length > 0 && !(await widenScope(projectId, ticket, violations))) {
      const kept = continuing
        ? null
        : await commitAndPush(checkout, {
            branch,
            subject: `${ticket.key}: ${outcome.value.summary}`,
            body: outcome.value.detail,
          });
      await askForScope(projectId, { ...ticket, branchName: branch }, violations, { kept: !!kept?.ok });
      await run.finish(outcome);
      return;
    }

    const pushed = await commitAndPush(checkout, {
      branch,
      subject: `${ticket.key}: ${outcome.value.summary}`,
      body: outcome.value.detail,
    });

    if (!pushed.ok) {
      await stallTicket(projectId, ticket, pushed.reason, {
        blocked: false,
        stalledIn: "in_progress",
        stage: STAGE_CODE_RUN,
      });
      await run.finish({ ...outcome, ok: false, error: pushed.reason, blocked: false });
      return;
    }

    await openTicketPullRequest(projectId, ticket, client, {
      branch,
      change: outcome.value,
      usage: outcome.usage,
    });
    await run.finish(outcome);
  } finally {
    await checkout.dispose();
  }
}

/**
 * The agent's change is on the ticket's branch: open its pull request (or
 * find the one already open from it) and move the card to In Review.
 */
export async function openTicketPullRequest(
  projectId: string,
  ticket: TicketDetail,
  client: VcsClient,
  input: { branch: string; change: CodeChange; usage?: Usage },
): Promise<void> {
  // A scout's change stops at its branch: the Reviewer Agent picks among them.
  if (ticket.scoutOf) {
    await scoutReturned(projectId, ticket, { ok: true, branch: input.branch, change: input.change, usage: input.usage });
    return;
  }
  const repo = repository();
  await recordFollowUps(ticket.id, input.change.followUps ?? []);
  // A scout sent mid-run was kept first: its change is the pull request.
  const current = await repo.ticketDetail(ticket.id);
  if (current?.scoutPick && current.branchName !== input.branch) return;
  const project = await projectFor(projectId);
  const target = mergeTarget(project.baseBranch);
  await ensureMergeTarget(client, target, project.baseBranch);

  // A stacked ticket's pull request targets the branch it was built on, so
  // its diff is its own layer, until the one under it merges.
  const stacked = (await repo.ticketDetail(ticket.id))?.stackedOn ?? null;
  const pull =
    (await client.findPullRequest(input.branch)) ??
    (await client.openPullRequest({
      headBranch: input.branch,
      baseBranch: stacked ?? target,
      title: pullRequestTitle(ticket, input.change),
      body: pullRequestBody(ticket, input.change),
    }));

  await repo.updateTicket(ticket.id, {
    status: "review",
    stalledIn: null,
    stage: STAGE_PR_OPEN,
    prNumber: pull.number,
    prUrl: pull.url,
    summary: input.change.summary,
    handoff: input.change.handoff ?? [],
    // Whatever the reviewer saw before, this is new work: it is reviewed again.
    reviewedSha: null,
    blockedReason: null,
    ...(input.usage
      ? {
          costCents: input.usage.costCents,
          tokensIn: input.usage.tokensIn,
          tokensOut: input.usage.tokensOut,
        }
      : {}),
  });
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: "review",
    stalledIn: null,
    stage: STAGE_PR_OPEN,
    blockedReason: null,
  });
  await publish(projectId, {
    type: "ci.status",
    ticketId: ticket.id,
    prNumber: pull.number,
    state: "pending",
    checkName: null,
  });

  // The one under it merged while this one was being written: it moves onto
  // the merge target now rather than waiting for a merge it already missed.
  const opened = { ...ticket, prNumber: pull.number, stackedOn: stacked };
  const below = await ticketBelow(opened);
  if (stacked && below?.status === "merged") await restack(projectId, opened, client, target, below.key);

  // Tickets waiting on this one can build on it now that its pull request is open.
  await releaseWaiting(projectId);

  // The review starts now, alongside CI, rather than on CI's first webhook.
  // With a mock GitHub no webhook will ever arrive at all, so this is also
  // what makes the no-credential demo reach Done.
  const { reviewPullRequest } = await import("@/lib/review/pipeline");
  launch(
    () => reviewPullRequest(projectId, pull.number, pull.headSha),
    `review for ${ticket.key}`,
  );
}
