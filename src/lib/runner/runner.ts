import "server-only";

import { randomUUID } from "node:crypto";

import type { RunHandle } from "@/lib/agents/pipeline";
import type { CliAgent } from "@/lib/agents/presets";
import { failuresBrief, taskBrief } from "@/lib/agents/coder";
import { CODER_BRIEF, REVIEWER_BRIEF } from "@/lib/agents/prompts";
import type { FailingCheck } from "@/lib/agents/ports";
import { projectFor } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { violationsInDiff } from "@/lib/domain/scope";
import { publish } from "@/lib/events/bus";
import { STAGING_PREFIX, VcsError, vcs, type VcsClient } from "@/lib/vcs";
import { openTicketPullRequest, stallTicket, taskFor } from "@/lib/coder/pipeline";
import {
  RUNNER_SETUP_BRANCH,
  RUNNER_VERSION,
  RUNNER_WORKFLOW_FILE,
  RUNNER_WORKFLOW_PATH,
  jobId,
  runnerWorkflow,
  ticketOfJob,
  type RunnerMode,
} from "./workflow";

/**
 * The cloud runner: a CLI agent on the person's own plan, working in their
 * repository's GitHub Actions.
 *
 * Starting a run is a dispatch and returns at once; the agent can take an
 * hour, which no request here can wait for. Its result comes back on the
 * workflow_run webhook and goes through the same gates as every other agent's
 * work: the file scope first, then the pull request, CI, and the merge loop.
 */

/** Dispatch inputs are capped at 65,535 characters in total. */
const MAX_PROMPT = 50_000;

const CLI_RULES = `Rules that are enforced, not advisory:
- Only change files inside the ticket's file scope. Formic compares your changes to it, and throws the whole run away if anything outside it changed.
- Match the surrounding code. Read neighbouring files before you write.
- Verify before you finish. Find the project's own check command and run it.
- Do not commit, push, or create branches. Formic does that after checking your changes.
- Do not skip, delete or weaken a test to make a command pass.
- When you are done, write a summary to the file named by the FORMIC_SUMMARY environment variable: a one-line summary under 70 characters, a blank line, then what changed and why.`;

export type RunnerState =
  | { ready: true }
  | { ready: false; setupUrl: string };

/**
 * Whether the repository has the current runner workflow on its base
 * branch. If not, opens (or refreshes) a pull request that adds it: a
 * workflow is code that runs with the repository's secrets, so a person
 * merges it, once.
 */
export async function ensureRunner(client: VcsClient, baseBranch: string): Promise<RunnerState> {
  const current = await client.readFile(RUNNER_WORKFLOW_PATH, baseBranch);
  if (current?.includes(RUNNER_VERSION)) return { ready: true };

  await client.ensureBranch(RUNNER_SETUP_BRANCH, baseBranch);
  const onBranch = await client.readFile(RUNNER_WORKFLOW_PATH, RUNNER_SETUP_BRANCH);
  if (!onBranch?.includes(RUNNER_VERSION)) {
    await client.commitFile(
      RUNNER_SETUP_BRANCH,
      RUNNER_WORKFLOW_PATH,
      runnerWorkflow(),
      "Add the Formic agent workflow",
    );
  }

  const pull =
    (await client.findPullRequest(RUNNER_SETUP_BRANCH)) ??
    (await client.openPullRequest({
      headBranch: RUNNER_SETUP_BRANCH,
      baseBranch,
      title: "Let Formic run coding agents in GitHub Actions",
      body: [
        "Formic runs CLI coding agents (Claude Code, Codex, Gemini CLI) in this repository's GitHub Actions, on your own plan.",
        "",
        "This adds the workflow that does it. It only runs when Formic starts it, pushes the agent's work to a `formic-staging/` branch, and never to a real branch: Formic checks the change against the ticket's file scope first, then opens a pull request as usual.",
        "",
        "Merge this once, then retry the card.",
      ].join("\n"),
    }));
  return { ready: false, setupUrl: pull.url };
}

/** What a 403 or 404 from the runner's endpoints usually means. */
function explain(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof VcsError && (e.status === 403 || e.status === 404)) {
    return `${message}. Formic's GitHub App needs Actions, Secrets and Workflows (read and write) on this repository, and the workflow must be on its default branch.`;
  }
  return message;
}

function cap(text: string): string {
  return text.length > MAX_PROMPT ? `${text.slice(0, MAX_PROMPT)}\n\n[cut short]` : text;
}

export function cliPrompt(
  agent: CliAgent,
  mode: RunnerMode,
  ticket: TicketDetail,
  fix?: { checks: FailingCheck[]; attempt: number; maxAttempts: number },
): string {
  const brief = agent.brief ?? (mode === "implement" ? CODER_BRIEF : REVIEWER_BRIEF);
  const task = taskBrief(taskFor(ticket));
  const work = fix
    ? [
        `This is fix attempt ${fix.attempt} of ${fix.maxAttempts}. After the last one the card stops and waits for a human.`,
        "",
        "Failing checks:",
        "",
        failuresBrief(fix.checks),
      ].join("\n")
    : "Implement it.";
  return cap([brief.trim(), "", CLI_RULES, "", task, "", work].join("\n"));
}

/**
 * Starts a CLI agent on a ticket. The Formic run records the dispatch and
 * ends there; the ticket stays running until the workflow reports back.
 */
export async function startCliRun(input: {
  projectId: string;
  ticket: TicketDetail;
  mode: RunnerMode;
  agent: CliAgent;
  /** The branch the agent starts from. */
  from: string;
  prompt: string;
  run: RunHandle;
  stalledIn: "in_progress" | "in_review";
  stage?: number;
}): Promise<void> {
  const { projectId, ticket, agent, run } = input;
  const usage = { model: agent.model ?? agent.info.label, tokensIn: 0, tokensOut: 0, costCents: 0 };

  const stop = async (reason: string, blocked: boolean) => {
    await repository().updateTicket(ticket.id, { runnerJob: null });
    await stallTicket(projectId, ticket, reason, {
      blocked,
      stalledIn: input.stalledIn,
      stage: input.stage,
    });
    await run.finish({ ok: false, error: reason, blocked, usage });
  };

  if (!agent.credential) {
    await stop(`This agent has no ${agent.info.keyName}. Edit it and add one.`, true);
    return;
  }

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  try {
    const runner = await ensureRunner(client, project.baseBranch);
    if (!runner.ready) {
      await stop(
        `${agent.info.label} runs in this repository's GitHub Actions. Merge the setup pull request once (${runner.setupUrl}), then move this card back to To Do to try again.`,
        true,
      );
      return;
    }

    // Set on every run, so a replaced token takes effect on the next one.
    await client.setSecret(agent.info.secretName, agent.credential);

    // Recorded first: only this job's result is taken, whatever else lands.
    const job = jobId(ticket.id, randomUUID().slice(0, 8));
    await repository().updateTicket(ticket.id, { runnerJob: job });
    await client.dispatchWorkflow(RUNNER_WORKFLOW_FILE, project.baseBranch, {
      job,
      mode: input.mode,
      ticket: ticket.key,
      cli: agent.info.cli,
      model: agent.model ?? "",
      from: input.from,
      prompt: input.prompt,
    });
  } catch (e) {
    await stop(`Could not start ${agent.info.label}: ${explain(e)}`, false);
    return;
  }

  run.ctx.emit({
    type: "run.log",
    runId: run.runId,
    stream: "stdout",
    line: `${agent.info.label} is working in GitHub Actions. This card moves on when it finishes.`,
  });
  await run.finish({ ok: true, value: null, usage });
}

export interface RunnerResult {
  job: string;
  mode: RunnerMode;
  /** The workflow run's conclusion: success, failure, cancelled, timed_out… */
  conclusion: string;
  /** The run on GitHub, for a human to read the log. */
  url: string | null;
}

/**
 * The workflow finished. Takes the agent's work from its staging branch,
 * checks it, and moves it onto the ticket's branch: a new pull request for
 * an implementation, one more commit on the existing one for a fix.
 */
export async function completeCliRun(projectId: string, result: RunnerResult): Promise<void> {
  const repo = repository();
  const ticketId = ticketOfJob(result.job);
  if (!ticketId) return;
  if ((await repo.projectOfCard(ticketId)) !== projectId) return;

  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket) return;

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  const staging = `${STAGING_PREFIX}${result.job}`;
  const cleanUp = () => client.deleteStagingBranch(staging).catch(() => undefined);

  // A result nobody is waiting for any more: the card was moved or retried,
  // or this result was already taken.
  const waiting =
    ticket.runnerJob === result.job &&
    !!ticket.branchName &&
    (result.mode === "implement"
      ? ticket.status === "running" && !ticket.prNumber
      : ticket.status === "review" && !!ticket.prNumber);
  if (!waiting) {
    await cleanUp();
    return;
  }
  await repo.updateTicket(ticket.id, { runnerJob: null });

  const stalledIn = result.mode === "implement" ? "in_progress" : "in_review";
  const log = result.url ? ` Its log: ${result.url}` : "";
  const stop = async (reason: string, blocked: boolean) => {
    await cleanUp();
    await stallTicket(projectId, ticket, reason, { blocked, stalledIn });
  };

  if (result.conclusion !== "success") {
    await stop(`The agent's GitHub Actions run ended as ${result.conclusion}.${log}`, false);
    return;
  }

  const branch = ticket.branchName!;
  const from = result.mode === "implement" ? project.baseBranch : branch;

  try {
    const change = await client.compare(from, staging);
    if (change.files.length === 0 || !change.headSha) {
      await stop(`The agent finished without changing anything.${log}`, result.mode === "fix");
      return;
    }

    const violations = violationsInDiff(change.files, ticket.fileScope);
    if (violations.length > 0) {
      await stop(
        `Out of scope: ${violations.slice(0, 5).join(", ")}` +
          `${violations.length > 5 ? ` and ${violations.length - 5} more` : ""}. ` +
          `${ticket.key} may only touch ${ticket.fileScope.join(", ")}. Nothing was pushed.`,
        true,
      );
      return;
    }

    // Fast-forward only. If the branch moved while the agent worked, this
    // refuses rather than overwrite what moved it.
    await client.moveBranch(branch, change.headSha);
    await cleanUp();

    if (result.mode === "fix") {
      await publish(projectId, {
        type: "ci.status",
        ticketId: ticket.id,
        prNumber: ticket.prNumber!,
        state: "pending",
        checkName: null,
      });
      return;
    }

    const message = change.messages.at(-1) ?? "";
    const [first, ...rest] = message.split("\n");
    const line = (first ?? "").trim();
    const summary =
      (line.startsWith(`${ticket.key}:`) ? line.slice(ticket.key.length + 1).trim() : line) ||
      ticket.title;
    await openTicketPullRequest(projectId, ticket, client, {
      branch,
      change: { summary, detail: rest.join("\n").trim(), verifiedWith: null },
    });
  } catch (e) {
    await stop(`Could not take the agent's work: ${explain(e)}`, false);
  }
}
