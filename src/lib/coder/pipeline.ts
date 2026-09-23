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
import { agentFor, modelFor } from "@/lib/agents/presets";

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

    const target = mergeTarget(project.baseBranch);
    await ensureMergeTarget(client, target, project.baseBranch);

    const pull = await client.openPullRequest({
      headBranch: branch,
      baseBranch: target,
      title: `${ticket.key}: ${outcome.value.summary}`,
      body: pullRequestBody(ticket, outcome.value),
    });

    await repo.updateTicket(ticket.id, {
      status: "review",
      stalledIn: null,
      stage: STAGE_PR_OPEN,
      prNumber: pull.number,
      prUrl: pull.url,
      summary: outcome.value.summary,
      blockedReason: null,
      costCents: outcome.usage.costCents,
      tokensIn: outcome.usage.tokensIn,
      tokensOut: outcome.usage.tokensOut,
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

    await run.finish(outcome);

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
  } finally {
    await checkout.dispose();
  }
}
