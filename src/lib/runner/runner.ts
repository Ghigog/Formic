import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  applyPrd,
  applyShowcase,
  applyTickets,
  stallEpic,
  startRun,
  type RunHandle,
} from "@/lib/agents/pipeline";
import { cliAgentFor, type CliAgent } from "@/lib/agents/presets";
import { diagnose, lastWords } from "@/lib/agents/limits";
import { planFromSummary } from "@/lib/agents/plan";
import { provider as providerInfo } from "@/lib/llm/providers";
import type { ColumnId } from "@/lib/domain/status";
import { failuresBrief, taskBrief } from "@/lib/agents/coder";
import {
  ALREADY_DONE_RULE,
  ARCHITECT_BRIEF,
  CODER_BRIEF,
  PRODUCT_BRIEF,
  REVIEWER_BRIEF,
  SHOWCASE_BRIEF,
  ENGINEERING_PRACTICES,
  withPlanningConventions,
  withProductConventions,
} from "@/lib/agents/prompts";
import type { DraftTicket, FailingCheck } from "@/lib/agents/ports";
import {
  MAX_DECOMPOSITION_ATTEMPTS,
  checkDecomposition,
  decompositionSchema,
} from "@/lib/agents/decomposition";
import { productOutput } from "@/lib/agents/openai-agents";
import { extractJson } from "@/lib/llm/openai-compat";
import { prdSchema, type PlanStep } from "@/lib/domain/entities";
import { directoryTree } from "@/lib/vcs/repositories";
import { projectFor } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { violationsInDiff } from "@/lib/domain/scope";
import { publish } from "@/lib/events/bus";
import { signingSecret } from "@/lib/auth/session";
import { abortTicketRuns } from "@/lib/budget/controller";
import { ticketNotes } from "@/lib/coder/notes";
import { readStream } from "./stream";
import { STAGING_PREFIX, VcsError, vcs, type VcsClient } from "@/lib/vcs";
import { openTicketPullRequest, stallTicket, taskFor } from "@/lib/coder/pipeline";
import {
  ANSWER_PATH,
  RUNNER_SETUP_BRANCH,
  RUNNER_VERSION,
  RUNNER_WORKFLOW_FILE,
  RUNNER_WORKFLOW_PATH,
  attemptOfJob,
  cardOfJob,
  isAnswerMode,
  jobId,
  parseRunTitle,
  runnerResultKey,
  runnerWorkflow,
  type AnswerMode,
  type CodeMode,
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
- When you are done, write a summary to the file named by the FORMIC_SUMMARY environment variable: a one-line summary under 70 characters, a blank line, then what changed and why. End it with a "Plan:" section listing the steps you took, one per line, as "- [x] step", or "- [ ] step" for any you left undone.`;

/**
 * The trailer that marks a CLI agent's report that the ticket was already
 * done. The workflow only hands work back when there is a commit, so the
 * agent makes an empty one; that keeps the installed workflow unchanged.
 */
export const ALREADY_DONE_TRAILER = "Formic-Already-Done: true";

const CLI_ALREADY_DONE = `To report it as already done: change no files, write the summary file as usual with the evidence as its body and \`${ALREADY_DONE_TRAILER}\` as its last line, then run exactly this, the one commit you may make:
git -c user.name="Formic Agent" -c user.email=formic-agent@users.noreply.github.com commit --allow-empty -q -F "$FORMIC_SUMMARY"`;

/** Whether a CLI agent's commits report the ticket as already done. */
export function reportsAlreadyDone(messages: string[]): boolean {
  return messages.some((m) => m.split("\n").some((line) => line.trim() === ALREADY_DONE_TRAILER));
}

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
      title: "Let Formic run agents in GitHub Actions",
      body: [
        "Formic runs CLI agents (Claude Code, Codex, Gemini CLI) in this repository's GitHub Actions, on your own plan.",
        "",
        "This adds the workflow that does it. It only runs when Formic starts it, pushes the agent's work to a `formic-staging/` branch, and never to a real branch: Formic checks the change against the ticket's file scope first, then opens a pull request as usual.",
        "",
        "Planning agents (PRDs, tickets, showcases) run here too. They read the repository and hand back an answer; nothing they touch is kept.",
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

/** The column whose agent runs each mode, or the board's assistant. */
const MODE_AGENT: Record<RunnerMode, ColumnId | "assistant"> = {
  implement: "in_progress",
  fix: "in_review",
  product: "backlog",
  architect: "todo",
  showcase: "done",
  ask: "assistant",
};

/**
 * Why a run did not succeed, in words a card can show. GitHub only says
 * "failure"; the agent's reason is in the log, so this reads it. A usage
 * limit with a reset time also marks the agent out until then, which greys
 * its column out on the board.
 */
async function whyItFailed(
  projectId: string,
  client: VcsClient,
  result: RunnerResult,
): Promise<string> {
  const log = result.url ? ` Its log: ${result.url}` : "";
  if (result.conclusion === "cancelled") return `The agent's GitHub Actions run was cancelled.${log}`;
  if (result.conclusion === "timed_out") {
    return `The agent ran past the workflow's 60-minute limit and was stopped.${log}`;
  }
  const plain = `The agent's GitHub Actions run ended as ${result.conclusion}.${log}`;
  const text = result.url ? await client.runLog(result.url).catch(() => null) : null;
  if (!text) return plain;

  const repo = repository();
  const where = MODE_AGENT[result.mode];
  const presetId =
    where === "assistant"
      ? await repo.assistantAgent(projectId)
      : (await repo.columnAgents(projectId))[where];
  const found = presetId ? await repo.presetForRun(presetId) : null;
  const label = found
    ? (providerInfo(found.preset.provider)?.label ?? "The agent").split(" (")[0]!
    : "The agent";

  const diagnosis = diagnose(text, label);
  if (!diagnosis) {
    const last = lastWords(text);
    return last ? `The agent's GitHub Actions run failed: "${last}".${log}` : plain;
  }
  if (diagnosis.kind === "limit" && diagnosis.until && found) {
    await repo.setPresetLimit(found.preset.id, { until: diagnosis.until, note: diagnosis.message });
    await publish(projectId, {
      type: "agent.limited",
      presetId: found.preset.id,
      until: diagnosis.until.toISOString(),
      note: diagnosis.message,
    });
  }
  return `${diagnosis.message}${log}`;
}

/**
 * The Actions secret a saved agent's sign-in lives in: its own, so two
 * Claude accounts on one repository never swap tokens between runs.
 */
export function secretNameFor(agent: Pick<CliAgent, "presetId" | "info">): string {
  if (!agent.presetId) return agent.info.secretName;
  return `${agent.info.secretName}_${agent.presetId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * What a CLI agent's run leaves for the ticket view: it works out of sight
 * in GitHub Actions, so its plan and its account of the work are read from
 * its summary once it is done.
 */
async function recordCliWork(projectId: string, ticketId: string, summary: string): Promise<void> {
  const steps = planFromSummary(summary);
  if (steps.length > 0) {
    await repository().updateTicket(ticketId, { plan: steps });
    await publish(projectId, { type: "ticket.plan", ticketId, steps });
  }
  const text = summary.trim();
  if (text) {
    await publish(projectId, { type: "run.thought", runId: "", ticketId, kind: "text", text: text.slice(0, 4_000) });
  }
}

function cap(text: string): string {
  return text.length > MAX_PROMPT ? `${text.slice(0, MAX_PROMPT)}\n\n[cut short]` : text;
}

export function cliPrompt(
  agent: CliAgent,
  mode: CodeMode,
  ticket: TicketDetail,
  fix?: { checks: FailingCheck[]; attempt: number; maxAttempts: number },
  notes: string[] = [],
): string {
  const brief = agent.brief ?? (mode === "implement" ? CODER_BRIEF : REVIEWER_BRIEF);
  const task = taskBrief(taskFor(ticket, notes));
  const work = fix
    ? [
        `This is fix attempt ${fix.attempt} of ${fix.maxAttempts}. After the last one the card stops and waits for a human.`,
        "",
        "Failing checks:",
        "",
        failuresBrief(fix.checks),
      ].join("\n")
    : ["Implement it.", "", ALREADY_DONE_RULE, "", CLI_ALREADY_DONE].join("\n");
  return cap(
    [brief.trim(), "", CLI_RULES, "", ENGINEERING_PRACTICES, "", task, "", work].join("\n"),
  );
}

/**
 * Sets the repository up, stores the credential, records the job and
 * dispatches it. Returns why it could not, if it could not.
 */
async function dispatch(input: {
  client: VcsClient;
  baseBranch: string;
  agent: CliAgent;
  job: string;
  mode: RunnerMode;
  cardKey: string;
  from: string;
  prompt: string;
  /** Recorded before the dispatch: only this job's result is taken. */
  record: (job: string) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; reason: string; blocked: boolean }> {
  const { client, agent } = input;
  if (!agent.credential) {
    return { ok: false, reason: `This agent has no ${agent.info.keyName}. Edit it and add one.`, blocked: true };
  }
  try {
    const runner = await ensureRunner(client, input.baseBranch);
    if (!runner.ready) {
      return {
        ok: false,
        reason: `${agent.info.label} runs in this repository's GitHub Actions. Merge the setup pull request once (${runner.setupUrl}), then move this card back to try again.`,
        blocked: true,
      };
    }

    // Set on every run, so a replaced token takes effect on the next one.
    const secret = secretNameFor(agent);
    await client.setSecret(secret, agent.credential);

    await input.record(input.job);
    await client.dispatchWorkflow(RUNNER_WORKFLOW_FILE, input.baseBranch, {
      job: input.job,
      mode: input.mode,
      ticket: input.cardKey,
      cli: agent.info.cli,
      model: agent.model ?? "",
      from: input.from,
      secret,
      prompt: cap(input.prompt),
      report: reportUrl(input.job, Date.now()) ?? "",
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Could not start ${agent.info.label}: ${explain(e)}`, blocked: false };
  }
}

function noUsage(agent: CliAgent) {
  return { model: agent.model ?? agent.info.label, tokensIn: 0, tokensOut: 0, costCents: 0 };
}

function working(agent: CliAgent, run: RunHandle, ticketId: string | null): void {
  run.ctx.emit({
    type: "run.log",
    runId: run.runId,
    ticketId,
    stream: "stdout",
    line: `${agent.info.label} is working in GitHub Actions. This card moves on when it finishes.`,
  });
}

/**
 * Starts a CLI agent on a ticket. The Formic run records the dispatch and
 * ends there; the ticket stays running until the workflow reports back.
 */
export async function startCliRun(input: {
  projectId: string;
  ticket: TicketDetail;
  mode: CodeMode;
  agent: CliAgent;
  /** The branch the agent starts from. */
  from: string;
  prompt: string;
  run: RunHandle;
  stalledIn: "in_progress" | "in_review";
  stage?: number;
}): Promise<void> {
  const { projectId, ticket, agent, run } = input;
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);

  const started = await dispatch({
    client: vcs(project.repoFullName, creds.githubToken),
    baseBranch: project.baseBranch,
    agent,
    job: jobId(ticket.id, randomUUID().slice(0, 8)),
    mode: input.mode,
    cardKey: ticket.key,
    from: input.from,
    prompt: input.prompt,
    record: (job) => repository().updateTicket(ticket.id, { runnerJob: job }),
  });

  if (!started.ok) {
    await repository().updateTicket(ticket.id, { runnerJob: null });
    await stallTicket(projectId, ticket, started.reason, {
      blocked: started.blocked,
      stalledIn: input.stalledIn,
      stage: input.stage,
    });
    await run.finish({ ok: false, error: started.reason, blocked: started.blocked, usage: noUsage(agent) });
    return;
  }

  working(agent, run, ticket.id);
  await run.finish({ ok: true, value: null, usage: noUsage(agent) });
}

/* ------------------------------------------------------------------------ */
/* Planning agents: an answer, not a change.                                 */
/* ------------------------------------------------------------------------ */

/** Where each planning stage stalls, and the attempts it gets. */
const ANSWER_STAGE: Record<
  AnswerMode,
  { stalledIn: "backlog" | "todo" | null; stage: number; attempts: number; role: "product" | "architect" | "pm" }
> = {
  product: { stalledIn: "backlog", stage: 2, attempts: 2, role: "product" },
  architect: { stalledIn: "todo", stage: 3, attempts: MAX_DECOMPOSITION_ATTEMPTS, role: "architect" },
  showcase: { stalledIn: null, stage: 8, attempts: 1, role: "pm" },
};

const ANSWER_RULES = `How to answer:
- Read the repository as much as you need to ground your answer in what is really there.
- Do not change, create or delete any file in the repository. Nothing you change is kept.
- Do not commit, push, or create branches.
- Write your final answer, and nothing else, to the file named by the FORMIC_OUTPUT environment variable.`;

function jsonShape(schema: z.ZodType): string {
  return `Your answer is a single JSON object and nothing else, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

/** What the merged tickets of an Epic did, for its showcase. */
export function showcaseSummaries(
  tickets: TicketDetail[],
): Array<{ key: string; title: string; summary: string }> {
  return tickets.map((t) => ({
    key: t.key,
    title: t.title,
    summary: t.summary ?? t.description.split("\n")[0] ?? t.title,
  }));
}

/** The prompt for a planning stage, built from the Epic as it is now. */
async function answerPrompt(
  projectId: string,
  epicId: string,
  mode: AnswerMode,
  agent: CliAgent,
  tree: () => Promise<string[]>,
): Promise<string | null> {
  const repo = repository();
  const epic = await repo.epicDetail(epicId);
  if (!epic) return null;

  if (mode === "product") {
    return [
      withProductConventions(agent.brief ?? PRODUCT_BRIEF),
      "",
      ANSWER_RULES,
      jsonShape(productOutput),
      "",
      "Raw feature request:",
      "",
      epic.rawRequest,
    ].join("\n");
  }

  const prd = prdSchema.safeParse(epic.prd);
  if (mode === "architect") {
    if (!prd.success) return null;
    return [
      withPlanningConventions(agent.brief ?? ARCHITECT_BRIEF),
      "",
      ANSWER_RULES,
      jsonShape(decompositionSchema),
      "",
      `Epic: ${epic.title}`,
      "",
      "PRD:",
      JSON.stringify(prd.data, null, 2),
      "",
      "Existing top-level directories in the repository:",
      (await tree()).slice(0, 200).join("\n") || "(empty repository)",
    ].join("\n");
  }

  const tickets = await repo.ticketsForEpic(epicId);
  return [
    (agent.brief ?? SHOWCASE_BRIEF).trim(),
    "",
    ANSWER_RULES,
    "Your answer is Markdown.",
    "",
    `Epic: ${epic.title}`,
    prd.success ? `\nOriginal intent: ${prd.data.summary}` : "",
    "",
    "Merged tickets:",
    ...showcaseSummaries(tickets).map((t) => `- ${t.key} ${t.title}: ${t.summary}`),
  ].join("\n");
}

/**
 * Starts a CLI agent on a planning stage of an Epic: the PRD, the ticket
 * graph, or the showcase. Like a coding run, it returns once dispatched and
 * the answer arrives on the workflow_run webhook.
 */
export async function startCliAnswer(input: {
  projectId: string;
  epicId: string;
  mode: AnswerMode;
  agent: CliAgent;
  run: RunHandle;
  /** A second or later attempt: the previous answer and what was wrong. */
  retry?: { attempt: number; answer: string; correction: string };
}): Promise<void> {
  const { projectId, epicId, mode, agent, run } = input;
  const repo = repository();
  const stage = ANSWER_STAGE[mode];
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const card = await repo.cardById(epicId);

  const fail = async (reason: string, blocked: boolean) => {
    await repo.setEpicRunnerJob(epicId, null);
    if (stage.stalledIn) {
      await stallEpic(projectId, epicId, reason, { blocked, stalledIn: stage.stalledIn, stage: stage.stage });
    }
    await run.finish({ ok: false, error: reason, blocked, usage: noUsage(agent) });
  };

  const base = await answerPrompt(projectId, epicId, mode, agent, async () =>
    creds.githubToken
      ? ((await directoryTree(project.repoFullName, project.baseBranch, creds.githubToken)) ?? [])
      : [],
  );
  if (!card || !base) {
    await fail("This Epic has nothing to work from yet.", true);
    return;
  }

  const prompt = input.retry
    ? [
        base,
        "",
        `This is attempt ${input.retry.attempt} of ${stage.attempts}. Your previous answer was:`,
        "",
        input.retry.answer.slice(0, 20_000),
        "",
        input.retry.correction,
      ].join("\n")
    : base;

  const started = await dispatch({
    client: vcs(project.repoFullName, creds.githubToken),
    baseBranch: project.baseBranch,
    agent,
    job: jobId(epicId, randomUUID().slice(0, 8), input.retry?.attempt ?? 1),
    mode,
    cardKey: card.key,
    from: project.baseBranch,
    prompt,
    record: (job) => repo.setEpicRunnerJob(epicId, job),
  });
  if (!started.ok) {
    await fail(started.reason, started.blocked);
    return;
  }

  working(agent, run, null);
  await run.finish({ ok: true, value: null, usage: noUsage(agent) });
}

type Checked<T> = { ok: true; value: T } | { ok: false; correction: string };

function readJson(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return null;
  }
}

function checkProduct(text: string): Checked<z.infer<typeof productOutput>> {
  const raw = readJson(text);
  if (raw === null) {
    return { ok: false, correction: "That was not a JSON object. Answer with only the JSON object." };
  }
  const parsed = productOutput.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    correction: `That PRD does not match the schema: ${issue?.path.join(".")}: ${issue?.message}. Answer with the corrected JSON object.`,
  };
}

function checkTickets(text: string): Checked<DraftTicket[]> {
  const raw = readJson(text);
  if (raw === null) {
    return { ok: false, correction: "That was not a JSON object. Answer with only the JSON object." };
  }
  const checked = checkDecomposition(raw);
  return checked.ok ? { ok: true, value: checked.tickets } : checked;
}

/**
 * A planning agent's workflow finished. Reads its answer off the staging
 * branch and checks it exactly as an API agent's answer is checked: a
 * wrong answer goes back to the agent as a correction, a right one onto
 * the board.
 */
async function completeCliAnswer(
  projectId: string,
  result: RunnerResult & { mode: AnswerMode },
): Promise<void> {
  const repo = repository();
  const epicId = cardOfJob(result.job);
  if (!epicId) return;
  if ((await repo.projectOfCard(epicId)) !== projectId) return;
  const epic = await repo.epicDetail(epicId);
  if (!epic) return;

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  const staging = `${STAGING_PREFIX}${result.job}`;
  const cleanUp = () => client.deleteStagingBranch(staging).catch(() => undefined);

  if (epic.runnerJob !== result.job) {
    await cleanUp();
    return;
  }
  await repo.setEpicRunnerJob(epicId, null);

  const stage = ANSWER_STAGE[result.mode];
  const log = result.url ? ` Its log: ${result.url}` : "";
  const stall = async (reason: string, blocked: boolean) => {
    if (stage.stalledIn) {
      await stallEpic(projectId, epicId, reason, { blocked, stalledIn: stage.stalledIn, stage: stage.stage });
    }
  };

  if (result.conclusion !== "success") {
    await cleanUp();
    await stall(await whyItFailed(projectId, client, result), false);
    return;
  }

  let answer: string | null;
  try {
    answer = await client.readFile(ANSWER_PATH, staging);
  } catch (e) {
    answer = null;
    console.error("[formic] could not read the agent's answer:", e);
  }
  await cleanUp();
  if (!answer?.trim()) {
    await stall(`The agent finished without an answer.${log}`, false);
    return;
  }

  let checked: Checked<unknown>;
  if (result.mode === "product") {
    const product = checkProduct(answer);
    if (product.ok) return applyPrd(projectId, epicId, product.value.prd);
    checked = product;
  } else if (result.mode === "architect") {
    const tickets = checkTickets(answer);
    if (tickets.ok) return applyTickets(projectId, epicId, tickets.value);
    checked = tickets;
  } else {
    return applyShowcase(projectId, epicId, answer.trim());
  }

  const attempt = attemptOfJob(result.job);
  if (attempt >= stage.attempts) {
    await stall(
      result.mode === "architect"
        ? `The Architect Agent could not produce a valid dependency graph in ${stage.attempts} attempts. This Epic needs a human to split it.`
        : `The agent's answer could not be used: ${checked.correction}`,
      result.mode === "architect",
    );
    return;
  }

  // Ask again, with what was wrong. Its own run, so the board shows it.
  const agent = await cliAgentFor(projectId, result.mode === "product" ? "backlog" : "todo");
  if (!agent) {
    await stall(`The agent's answer could not be used: ${checked.correction}`, false);
    return;
  }
  await startCliAnswer({
    projectId,
    epicId,
    mode: result.mode,
    agent,
    run: startRun(projectId, stage.role, { epicId, model: agent.model ?? agent.info.label }),
    retry: { attempt: attempt + 1, answer, correction: checked.correction },
  });
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
/**
 * Starts a CLI agent answering the board's assistant. Its answer comes back
 * like a planning agent's, and the conversation shows it when it does.
 */
export async function startCliAsk(input: {
  projectId: string;
  messageId: string;
  agent: CliAgent;
  prompt: string;
  /** A second attempt, after its proposals were sent back. */
  attempt?: number;
}): Promise<void> {
  const repo = repository();
  const project = await projectFor(input.projectId);
  const creds = await credentialsForProject(project);
  const started = await dispatch({
    client: vcs(project.repoFullName, creds.githubToken),
    baseBranch: project.baseBranch,
    agent: input.agent,
    job: jobId(input.messageId, randomUUID().slice(0, 8), input.attempt ?? 1),
    mode: "ask",
    cardKey: "assistant",
    from: project.baseBranch,
    prompt: input.prompt,
    record: (job) => repo.updateAssistantMessage(input.messageId, { runnerJob: job }),
  });
  if (!started.ok) {
    const { finishCliAnswer } = await import("@/lib/assistant/turn");
    await finishCliAnswer(input.messageId, null, started.reason);
  }
}

/** When each board's runs were last looked up on GitHub, to go easy on the API. */
const lastLooked = new Map<string, number>();
const LOOK_EVERY_MS = 15_000;

/**
 * Collects finished CLI agent runs without waiting for the webhook: asks
 * GitHub which of the runs this board is waiting on have finished. The
 * webhook is the fast path; this is the one that cannot be missed, so a lost
 * delivery or an app not subscribed to workflow runs never leaves a card,
 * an Epic or a question hanging. Each result is claimed under the webhook's
 * own key, so whichever arrives first takes it and the other does nothing.
 */
export async function collectCliRuns(projectId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastLooked.get(projectId) ?? 0) < LOOK_EVERY_MS) return;
  lastLooked.set(projectId, now);

  const repo = repository();
  const waiting = new Set<string>();
  for (const card of await repo.boardCards(projectId)) {
    const job =
      card.kind === "epic"
        ? (await repo.epicDetail(card.id))?.runnerJob
        : card.status === "running" || card.status === "review"
          ? (await repo.ticketDetail(card.id))?.runnerJob
          : null;
    if (job) waiting.add(job);
  }
  for (const m of await repo.assistantMessages(projectId)) {
    if (m.status === "pending" && m.runnerJob) waiting.add(m.runnerJob);
  }
  if (waiting.size === 0) return;

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const runs = await vcs(project.repoFullName, creds.githubToken)
    .recentRuns(RUNNER_WORKFLOW_FILE)
    .catch(() => []);
  for (const run of runs) {
    const parsed = parseRunTitle(run.title);
    if (!parsed || !waiting.has(parsed.job) || run.status !== "completed") continue;
    if (!(await repo.claimDelivery(runnerResultKey(parsed.job, run.id)))) continue;
    await completeCliRun(projectId, {
      job: parsed.job,
      mode: parsed.mode,
      conclusion: run.conclusion ?? "failure",
      url: run.url,
    });
  }
}

async function completeCliAsk(projectId: string, result: RunnerResult): Promise<void> {
  const repo = repository();
  const messageId = cardOfJob(result.job);
  const message = messageId ? await repo.assistantMessage(messageId) : null;
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  const staging = `${STAGING_PREFIX}${result.job}`;
  const cleanUp = () => client.deleteStagingBranch(staging).catch(() => undefined);

  if (!message || message.projectId !== projectId || message.runnerJob !== result.job) {
    await cleanUp();
    return;
  }

  const { finishCliAnswer } = await import("@/lib/assistant/turn");
  if (result.conclusion !== "success") {
    await cleanUp();
    await finishCliAnswer(message.id, null, await whyItFailed(projectId, client, result));
    return;
  }
  const answer = await client.readFile(ANSWER_PATH, staging).catch(() => null);
  await cleanUp();
  await finishCliAnswer(message.id, answer, undefined, {
    projectId,
    attempt: attemptOfJob(result.job),
  });
}

export async function completeCliRun(projectId: string, result: RunnerResult): Promise<void> {
  const { mode } = result;
  if (mode === "ask") {
    await completeCliAsk(projectId, result);
    return;
  }
  if (isAnswerMode(mode)) {
    await completeCliAnswer(projectId, { ...result, mode });
    return;
  }
  const repo = repository();
  const ticketId = cardOfJob(result.job);
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
      ? ticket.status === "running"
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
    await stop(await whyItFailed(projectId, client, result), false);
    return;
  }

  const branch = ticket.branchName!;
  // A re-run with its pull request open started from the ticket's branch.
  const from = result.mode === "implement" && !ticket.prNumber ? project.baseBranch : branch;

  try {
    const change = await client.compare(from, staging);
    if (
      result.mode === "implement" &&
      change.files.length === 0 &&
      reportsAlreadyDone(change.messages)
    ) {
      await cleanUp();
      const message = change.messages.find((m) => m.includes(ALREADY_DONE_TRAILER)) ?? "";
      const [first, ...rest] = message.split("\n");
      const line = (first ?? "").trim();
      const { closeAlreadyDone } = await import("@/lib/review/pipeline");
      await closeAlreadyDone(projectId, ticket, {
        summary:
          (line.startsWith(`${ticket.key}:`) ? line.slice(ticket.key.length + 1).trim() : line) ||
          ticket.title,
        detail: rest
          .filter((l) => l.trim() !== ALREADY_DONE_TRAILER)
          .join("\n")
          .trim(),
      });
      return;
    }
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
      await recordCliWork(projectId, ticket.id, change.messages.at(-1) ?? "");
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
    await recordCliWork(projectId, ticket.id, message);
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

/* ------------------------------------------------------------------------ */
/* While it works: what it is doing, and a person stopping or steering it.  */
/* ------------------------------------------------------------------------ */

/**
 * Where the board is, for the workflow to report to. Null when it has no
 * public address, such as a laptop: the run then works as before, silently.
 */
export function formicOrigin(): string | null {
  const explicit = process.env.FORMIC_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel}` : null;
}

function reportToken(job: string, since: number): string {
  return createHmac("sha256", signingSecret()).update(`runner-report:${job}:${since}`).digest("hex");
}

/**
 * The address a run posts its output to. It carries its own proof: a token
 * that is good for this one job only, and only while the job is the one its
 * card waits on.
 */
export function reportUrl(job: string, since: number): string | null {
  const origin = formicOrigin();
  if (!origin) return null;
  const q = new URLSearchParams({ job, since: String(since), token: reportToken(job, since) });
  return `${origin}/api/runner/report?${q.toString()}`;
}

export function reportAllowed(job: string, since: string, token: string): boolean {
  if (!/^\d+$/.test(since)) return false;
  const expected = Buffer.from(reportToken(job, Number(since)));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The most a batch publishes; a flood of output keeps its latest part. */
const MAX_REPORT_ITEMS = 200;

export interface ReportReply {
  /** Notes the agent has not been sent yet, newest last. */
  notes: Array<{ seq: number; text: string }>;
  /** The card no longer waits on this job: stop reporting. */
  stop: boolean;
}

/**
 * A batch of a CLI agent's output, posted by the workflow while it works.
 * Publishes it as the ticket's thoughts, actions, plan and terminal lines,
 * and answers with any notes the person has left since `after`.
 */
export async function receiveReport(input: {
  job: string;
  since: number;
  lines: string[];
  after: number;
}): Promise<ReportReply> {
  const repo = repository();
  const cardId = cardOfJob(input.job);
  const ticket = cardId ? await repo.ticketDetail(cardId) : null;
  if (!ticket || ticket.runnerJob !== input.job) {
    // A planning column's run: its output is for the terminal only.
    const epic = cardId ? await repo.epicDetail(cardId) : null;
    if (epic && epic.runnerJob === input.job) {
      const projectId = await repo.projectOfCard(cardId!);
      if (projectId) {
        for (const item of readStream(input.lines).slice(-MAX_REPORT_ITEMS)) {
          if (item.kind !== "log") continue;
          await publish(projectId, { type: "run.log", runId: input.job, stream: item.stream, line: item.line });
        }
        return { notes: [], stop: false };
      }
    }
    return { notes: [], stop: true };
  }

  const projectId = await repo.projectOfCard(ticket.id);
  if (!projectId) return { notes: [], stop: true };

  const runId = input.job;
  let plan: PlanStep[] | null = null;
  for (const item of readStream(input.lines).slice(-MAX_REPORT_ITEMS)) {
    switch (item.kind) {
      case "thought":
        await publish(projectId, { type: "run.thought", runId, ticketId: ticket.id, kind: item.thought, text: item.text });
        break;
      case "action":
        await publish(projectId, {
          type: "run.progress",
          runId,
          ticketId: ticket.id,
          role: ticket.status === "review" ? "reviewer" : "coder",
          label: item.label,
          fraction: null,
        });
        break;
      case "plan":
        plan = item.steps;
        await publish(projectId, { type: "ticket.plan", ticketId: ticket.id, steps: item.steps });
        break;
      case "log":
        await publish(projectId, { type: "run.log", runId, ticketId: ticket.id, stream: item.stream, line: item.line });
        break;
    }
  }
  if (plan) await repo.updateTicket(ticket.id, { plan });

  const notes = (await ticketNotes(projectId, ticket.id, new Date(input.since)))
    .filter((n) => n.seq > input.after)
    .map((n) => ({ seq: n.seq, text: n.text }));
  return { notes, stop: false };
}

export const STOPPED_BY_PERSON =
  "Stopped by you. Leave a note on what to do differently, then move it back to run it again.";

/**
 * A person stopped the agent working a ticket. The card stalls where it is,
 * so nothing the agent still hands back is taken, and the agent is stopped
 * wherever it runs: its GitHub Actions run is cancelled, and a built-in
 * agent stops at its next turn. Returns whether there was anything to stop.
 */
export async function stopTicket(projectId: string, ticketId: string): Promise<boolean> {
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket) return false;
  const card = await repo.cardById(ticketId);
  const working = ticket.status === "running" || !!ticket.runnerJob || !!card?.workingSince;
  if (!working) return false;

  const job = ticket.runnerJob;
  await repo.updateTicket(ticket.id, { runnerJob: null });
  await stallTicket(projectId, ticket, STOPPED_BY_PERSON, {
    blocked: true,
    stalledIn: ticket.status === "review" ? "in_review" : "in_progress",
  });
  abortTicketRuns(ticket.id, STOPPED_BY_PERSON);

  if (job) {
    try {
      const project = await projectFor(projectId);
      const creds = await credentialsForProject(project);
      const client = vcs(project.repoFullName, creds.githubToken);
      for (const run of await client.recentRuns(RUNNER_WORKFLOW_FILE)) {
        if (parseRunTitle(run.title)?.job === job && run.status !== "completed") {
          await client.cancelRun(run.id);
        }
      }
    } catch (e) {
      // The card has stopped either way: whatever the run hands back is
      // for a job nobody waits on, and is thrown away.
      console.error("[formic] could not cancel the run:", explain(e));
    }
  }
  return true;
}
