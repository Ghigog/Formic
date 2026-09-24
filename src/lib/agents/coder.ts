import "server-only";

import type {
  AgentConfig,
  AgentContext,
  AgentOutcome,
  CodeChange,
  CoderAgent,
  CoderTask,
  FailingCheck,
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
          "Notes from the person watching this ticket. Follow them; where they disagree, the newest wins:",
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
    });
  }
}

export class LoopReviewerAgent implements ReviewerAgent {
  constructor(private readonly config: AgentConfig = {}) {}

  fix(
    ctx: AgentContext,
    input: {
      task: CoderTask;
      workspace: Workspace;
      checks: FailingCheck[];
      attempt: number;
      maxAttempts: number;
    },
  ): Promise<AgentOutcome<CodeChange>> {
    const failures = failuresBrief(input.checks);

    return runCodingLoop({
      ctx,
      workspace: input.workspace,
      ticketId: input.task.ticketId,
      role: "reviewer",
      system: withCodingRules(this.config.brief ?? REVIEWER_BRIEF),
      provider: this.config.provider,
      model: this.config.model,
      apiKey: this.config.apiKey,
      prompt: [
        taskBrief(input.task),
        "",
        `This is fix attempt ${input.attempt} of ${input.maxAttempts}. After the last one the card stops and waits for a human.`,
        "",
        "Failing checks:",
        "",
        failures,
      ].join("\n"),
    });
  }
}
