import "server-only";

import type {
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

/**
 * The two agents that write code. Same loop, different brief.
 */

const SHARED_RULES = `You are working inside a sandboxed checkout of a real repository. The tools run there, not on your machine.

Rules that are enforced, not advisory:
- You may only write inside the ticket's file scope. A write outside it is rejected, and a run whose diff strays outside it is thrown away before anything is pushed.
- Match the surrounding code. Read neighbouring files before you write; the conventions in this repository are not the ones in your training data.
- Verify before you finish. Find the project's own check command and run it. "It should work" is not a verification.
- Do not commit, push, or touch git history. The platform does that after it has checked your diff.
- Do not skip, delete or weaken a test to make a command pass.`;

const CODER_SYSTEM = `You implement one ticket in a repository, end to end.

${SHARED_RULES}

Work in this order: read enough of the repository to know where the change goes, make the smallest change that satisfies every acceptance criterion, run the project's checks, then call finish. Keep the change to what the ticket asks for; the file scope is narrow because another agent is working next to you.`;

const REVIEWER_SYSTEM = `You fix a pull request whose CI is red.

${SHARED_RULES}

You are given the failing checks and what they reported. Reproduce the failure in the sandbox first, then fix its cause. A test that fails because the code is wrong is fixed in the code. Do not chase a green tick by changing what is being asserted, and do not widen the change beyond what the failure needs. If the failure is not something this pull request can fix, say so in finish rather than editing at random.`;

function taskBrief(task: CoderTask): string {
  return [
    `Ticket ${task.key}: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    `File scope (you may write only inside these paths): ${task.fileScope.join(", ")}`,
  ].join("\n");
}

export class AnthropicCoderAgent implements CoderAgent {
  implement(
    ctx: AgentContext,
    input: { task: CoderTask; workspace: Workspace },
  ): Promise<AgentOutcome<CodeChange>> {
    return runCodingLoop({
      ctx,
      workspace: input.workspace,
      ticketId: input.task.ticketId,
      role: "coder",
      system: CODER_SYSTEM,
      prompt: `${taskBrief(input.task)}\n\nImplement it.`,
    });
  }
}

export class AnthropicReviewerAgent implements ReviewerAgent {
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
    const failures = input.checks
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

    return runCodingLoop({
      ctx,
      workspace: input.workspace,
      ticketId: input.task.ticketId,
      role: "reviewer",
      system: REVIEWER_SYSTEM,
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
