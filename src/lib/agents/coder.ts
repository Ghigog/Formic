import "server-only";

import type {
  AgentConfig,
  AgentContext,
  AgentOutcome,
  CodeChange,
  CoderAgent,
  CoderTask,
  FailingCheck,
  ReviewTask,
  ReviewVerdict,
  ReviewerAgent,
} from "./ports";
import { runCodingLoop } from "./coding-loop";
import type { Workspace } from "@/lib/sandbox/workspace";
import { ALREADY_DONE_RULE, CODER_BRIEF, REVIEWER_BRIEF, withCodingRules } from "./prompts";

/**
 * The two agents that write code. Same loop, different brief, and any
 * provider: the loop picks the connector from the agent's config.
 */

export function taskBrief(task: CoderTask): string {
  return [
    `Ticket ${task.key}: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    `File scope (you may write only inside these paths): ${task.fileScope.join(", ")}`,
    ...(task.notes?.length
      ? [
          "",
          "Notes on this ticket, from the person watching it or from its review. Follow them; where they disagree, the newest wins:",
          ...task.notes.map((n) => `- ${n}`),
        ]
      : []),
  ].join("\n");
}

/** What each red check reported, for the agent fixing it. */
export function failuresBrief(checks: FailingCheck[]): string {
  return checks
    .map((check) =>
      [
        `Check "${check.name}" failed.`,
        check.summary,
        ...check.annotations.map(
          (a) => `${a.path}${a.line ? `:${a.line}` : ""} — ${a.message}`,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function withoutSendBack({ sendBack: _, ...change }: CodeChange & { sendBack: string | null }): CodeChange {
  return change;
}

export class LoopCoderAgent implements CoderAgent {
  constructor(private readonly config: AgentConfig = {}) {}

  implement(
    ctx: AgentContext,
    input: { task: CoderTask; workspace: Workspace },
  ): Promise<AgentOutcome<CodeChange>> {
    return runCodingLoop({
      ctx,
      workspace: input.workspace,
      ticketId: input.task.ticketId,
      role: "coder",
      system: withCodingRules(this.config.brief ?? CODER_BRIEF),
      provider: this.config.provider,
      model: this.config.model,
      apiKey: this.config.apiKey,
      prompt: [
        taskBrief(input.task),
        "",
        "Implement it.",
        "",
        `${ALREADY_DONE_RULE} To report it, call finish with already_done set to true and the evidence in detail.`,
      ].join("\n"),
    }).then((outcome) =>
      outcome.ok ? { ...outcome, value: withoutSendBack(outcome.value) } : outcome,
    );
  }
}

export class LoopReviewerAgent implements ReviewerAgent {
  constructor(private readonly config: AgentConfig = {}) {}

  review(ctx: AgentContext, input: ReviewTask): Promise<AgentOutcome<ReviewVerdict>> {
    return runCodingLoop({
      ctx,
      workspace: input.workspace,
      ticketId: input.task.ticketId,
      role: "reviewer",
      system: withCodingRules(this.config.brief ?? REVIEWER_BRIEF),
      provider: this.config.provider,
      model: this.config.model,
      apiKey: this.config.apiKey,
      prompt: reviewBrief(input),
    });
  }
}

/** What the Reviewer Agent is told about the pull request in front of it. */
export function reviewBrief(input: Omit<ReviewTask, "workspace">): string {
  return [
    taskBrief(input.task),
    "",
    `The checkout is the pull request's branch. It merges into ${input.baseBranch}. To see the diff:`,
    `git fetch --depth 50 origin ${input.baseBranch} && git diff FETCH_HEAD...HEAD`,
    "",
    "Files it changes:",
    ...(input.changedFiles.length ? input.changedFiles.map((f) => `- ${f}`) : ["(none listed)"]),
    "",
    input.checks.length
      ? ["CI is red. Failing checks:", "", failuresBrief(input.checks)].join("\n")
      : "CI is green.",
    "",
    `This is review ${input.attempt} of ${input.maxAttempts}. After the last one the card stops and waits for a human.`,
  ].join("\n");
}
