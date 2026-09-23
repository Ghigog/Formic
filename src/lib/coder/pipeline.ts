import "server-only";

import { startRun, launch } from "@/lib/agents/pipeline";
import type { CoderTask } from "@/lib/agents/ports";
import { repository } from "@/lib/db";
import { projectFor } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";
import type { TicketDetail } from "@/lib/db/repository";
import { violationsInDiff } from "@/lib/domain/scope";
import { publish } from "@/lib/events/bus";
import { newBranchName } from "@/lib/sandbox";
import { mergeTarget, vcs } from "@/lib/vcs";
import {
  commitAndPush,
  ensureMergeTarget,
  openCheckout,
  pullRequestBody,
} from "./checkout";
import { agentFor, cliAgentFor, modelFor } from "@/lib/agents/presets";
import type { CodeChange, Usage } from "@/lib/agents/ports";
import type { VcsClient } from "@/lib/vcs";
import { cliPrompt, startCliRun } from "@/lib/runner/runner";

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

export function taskFor(ticket: TicketDetail): CoderTask {
  return {
    ticketId: ticket.id,
    key: ticket.key,
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
    fileScope: ticket.fileScope,
  };
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
  const status = options.blocked ? "blocked" : "failed";
  const stage = options.stage ?? ticket.stage;

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

export async function runCoderAgent(
  projectId: string,
  ticketId: string,
): Promise<void> {
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket) return;

  const project = await projectFor(projectId);
  const branch = ticket.branchName ?? newBranchName(ticket.key);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  const run = startRun(projectId, "coder", {
    model: await modelFor(projectId, "coder"),
    epicId: ticket.epicId,
    ticketId: ticket.id,
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

  // A CLI agent on the person's own plan works in GitHub Actions instead of
  // a sandbox here, and reports back on the workflow_run webhook.
  const cli = await cliAgentFor(projectId, "in_progress");
  if (cli) {
    await startCliRun({
      projectId,
      ticket: { ...ticket, branchName: branch },
      mode: "implement",
      agent: cli,
      from: project.baseBranch,
      prompt: cliPrompt(cli, "implement", ticket),
      run,
      stalledIn: "in_progress",
      stage: STAGE_CODE_RUN,
    });
    return;
  }

  const checkout = await openCheckout({
    projectId,
    repoFullName: project.repoFullName,
    fromBranch: project.baseBranch,
    newBranch: branch,
    ticket,
    ctx: run.ctx,
    githubToken: creds.githubToken,
    e2bKey: creds.e2bKey,
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
      task: taskFor(ticket),
      workspace: checkout.workspace,
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
      const reason = "The agent finished without changing anything.";
      await stallTicket(projectId, ticket, reason, {
        blocked: false,
        stalledIn: "in_progress",
        stage: STAGE_CODE_RUN,
      });
      await run.finish({ ...outcome, ok: false, error: reason, blocked: false });
      return;
    }

    // The file scope check that makes concurrency safe. A scoped workspace
    // already refuses out-of-scope writes, but an agent with a shell can go
    // around it, so the diff is checked again here — before a push, which is
    // the last moment the damage is still local to a sandbox.
    const violations = violationsInDiff(changed, ticket.fileScope);
    if (violations.length > 0) {
      const reason =
        `Out of scope: ${violations.slice(0, 5).join(", ")}` +
        `${violations.length > 5 ? ` and ${violations.length - 5} more` : ""}. ` +
        `${ticket.key} may only touch ${ticket.fileScope.join(", ")}. Nothing was pushed.`;
      await stallTicket(projectId, ticket, reason, {
        blocked: true,
        stalledIn: "in_progress",
        stage: STAGE_CODE_RUN,
      });
      await run.finish({ ...outcome, ok: false, error: reason, blocked: true });
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
  const repo = repository();
  const project = await projectFor(projectId);
  const target = mergeTarget(project.baseBranch);
  await ensureMergeTarget(client, target, project.baseBranch);

  const pull =
    (await client.findPullRequest(input.branch)) ??
    (await client.openPullRequest({
      headBranch: input.branch,
      baseBranch: target,
      title: `${ticket.key}: ${input.change.summary}`,
      body: pullRequestBody(ticket, input.change),
    }));

  await repo.updateTicket(ticket.id, {
    status: "review",
    stalledIn: null,
    stage: STAGE_PR_OPEN,
    prNumber: pull.number,
    prUrl: pull.url,
    summary: input.change.summary,
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

  // With a mock GitHub no webhook will ever arrive, so the card would sit
  // in In Review forever. Drive the next stage directly instead, which is
  // what makes the no-credential demo reach Done.
  if (client.name === "mock") {
    const { reviewPullRequest } = await import("@/lib/review/pipeline");
    launch(
      () => reviewPullRequest(projectId, pull.number, pull.headSha),
      `mock review for ${ticket.key}`,
    );
  }
}
