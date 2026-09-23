import type {
  AgentContext,
  AgentOutcome,
  ArchitectAgent,
  CodeChange,
  CoderAgent,
  CoderTask,
  DraftTicket,
  FailingCheck,
  ProductAgent,
  ReviewerAgent,
  ShowcaseAgent,
  Usage,
} from "./ports";
import type { PlanStep } from "@/lib/domain/entities";
import type { Prd } from "@/lib/domain/entities";
import type { Workspace } from "@/lib/sandbox/workspace";

/**
 * Canned agents. They stream, they take a plausible amount of time, and they
 * return data that passes the same validation the real ones do, so the board
 * can be driven end to end with no API key and no network.
 *
 * Set AGENT_PROVIDER=mock (the default when ANTHROPIC_API_KEY is unset).
 */

const MOCK_USAGE: Usage = {
  model: "mock",
  tokensIn: 0,
  tokensOut: 0,
  costCents: 0,
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function titleFrom(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  const firstClause = cleaned.split(/[.;\n]/)[0] ?? cleaned;
  const words = firstClause.split(" ").slice(0, 8).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class MockProductAgent implements ProductAgent {
  async draftPrd(
    ctx: AgentContext,
    input: { epicId: string; rawRequest: string },
  ): Promise<AgentOutcome<{ title: string; prd: Prd }>> {
    const title = titleFrom(input.rawRequest);
    const prd: Prd = {
      summary: `Deliver "${title}" end to end, from data model through UI, behind the existing project conventions.`,
      problem: input.rawRequest.trim(),
      scope: [
        "Data model and persistence for the feature",
        "Server endpoints with request validation",
        "UI surface wired to the endpoints",
        "Unit coverage for the non-trivial logic",
      ],
      outOfScope: [
        "Analytics instrumentation",
        "Migration of existing records",
      ],
      technicalContext: [
        "Next.js App Router with server components by default",
        "Prisma against Postgres",
        "Tailwind with the project design tokens",
      ],
      userStories: [
        `As a user, I can use ${title.toLowerCase()} without leaving the board.`,
        "As a user, I see a clear error when the operation fails.",
      ],
      successCriteria: [
        "The feature works end to end against a real database",
        "Failure states are visible rather than silent",
        "No new type or lint errors",
      ],
    };

    // Stream it the way the real agent does, so the drawer's streaming path is
    // exercised by the mock too.
    const text = JSON.stringify(prd, null, 2);
    for (let i = 0; i < text.length; i += 120) {
      await sleep(40, ctx.signal);
      ctx.emit({
        type: "epic.prd",
        epicId: input.epicId,
        delta: text.slice(i, i + 120),
        done: false,
      });
    }
    ctx.emit({ type: "epic.prd", epicId: input.epicId, delta: "", done: true });

    return { ok: true, value: { title, prd }, usage: MOCK_USAGE };
  }
}

export class MockArchitectAgent implements ArchitectAgent {
  async decompose(
    ctx: AgentContext,
    input: { epicId: string; title: string; prd: Prd; repoTree: string[] },
  ): Promise<AgentOutcome<DraftTicket[]>> {
    const steps = ["Reading PRD", "Mapping file boundaries", "Building DAG"];
    for (const [i, label] of steps.entries()) {
      ctx.emit({
        type: "run.progress",
        runId: ctx.runId,
        ticketId: null,
        role: "architect",
        label,
        fraction: (i + 1) / steps.length,
      });
      await sleep(300, ctx.signal);
    }

    // Disjoint scopes by construction, with a dependency chain that leaves two
    // tickets genuinely concurrent.
    const tickets: DraftTicket[] = [
      {
        key: "T-1",
        title: "Schema and migration",
        description: `Add the tables "${input.title}" needs and generate the migration.`,
        acceptanceCriteria: [
          "Migration applies cleanly against an empty database",
          "Generated client compiles",
        ],
        fileScope: ["prisma"],
        size: "S",
        storyPoints: 2,
        dependsOn: [],
      },
      {
        key: "T-2",
        title: "Server endpoints",
        description: "Request validation, handlers, and error mapping.",
        acceptanceCriteria: [
          "Every handler validates its body",
          "Failures return a typed error rather than a 500",
        ],
        fileScope: ["src/app/api"],
        size: "M",
        storyPoints: 5,
        dependsOn: ["T-1"],
      },
      {
        key: "T-3",
        title: "UI surface",
        description: "Components and the page that hosts them.",
        acceptanceCriteria: [
          "Renders at 375px with no horizontal scroll",
          "Uses design tokens, no raw hex",
        ],
        fileScope: ["src/components/feature"],
        size: "M",
        storyPoints: 5,
        dependsOn: ["T-1"],
      },
      {
        key: "T-4",
        title: "Unit coverage",
        description: "Tests for the non-trivial logic introduced above.",
        acceptanceCriteria: ["Tests pass", "Edge cases covered"],
        fileScope: ["src/lib/feature"],
        size: "S",
        storyPoints: 3,
        dependsOn: ["T-2", "T-3"],
      },
    ];

    return { ok: true, value: tickets, usage: MOCK_USAGE };
  }
}

export class MockShowcaseAgent implements ShowcaseAgent {
  async summarize(
    ctx: AgentContext,
    input: {
      epicId: string;
      title: string;
      prd: Prd | null;
      ticketSummaries: Array<{ key: string; title: string; summary: string }>;
    },
  ): Promise<AgentOutcome<string>> {
    await sleep(400, ctx.signal);
    const body = [
      `# ${input.title}`,
      "",
      input.prd?.summary ?? "",
      "",
      "## What shipped",
      "",
      ...input.ticketSummaries.map(
        (t) => `- **${t.key} ${t.title}** — ${t.summary}`,
      ),
      "",
      "## Try it",
      "",
      "1. Pull the base branch.",
      "2. Run the app.",
      "3. Exercise the new surface from the board.",
    ].join("\n");

    ctx.emit({ type: "epic.showcase", epicId: input.epicId, markdown: body });
    return { ok: true, value: body, usage: MOCK_USAGE };
  }
}

/** The file a mock run leaves behind, inside the ticket's first scope entry. */
function noteFor(task: CoderTask): { path: string; contents: string } {
  const root = task.fileScope[0] ?? "src";
  return {
    path: `${root}/${task.key.toLowerCase()}.md`,
    contents: [
      `# ${task.key} — ${task.title}`,
      "",
      task.description,
      "",
      "## Acceptance criteria",
      "",
      ...task.acceptanceCriteria.map((c) => `- [x] ${c}`),
      "",
      "_Written by the mock Coder Agent. No model was called._",
      "",
    ].join("\n"),
  };
}

export class MockCoderAgent implements CoderAgent {
  async implement(
    ctx: AgentContext,
    input: { task: CoderTask; workspace: Workspace },
  ): Promise<AgentOutcome<CodeChange>> {
    const { task, workspace } = input;
    const steps = [
      "Reading the ticket",
      "Locating the file scope",
      "Writing the change",
      "Running the checks",
    ];
    const plan = (done: number): PlanStep[] =>
      steps.map((step, i) => ({
        step,
        status: i < done ? "done" : i === done ? "in_progress" : "pending",
      }));

    for (const [i, label] of steps.entries()) {
      ctx.emit({ type: "ticket.plan", ticketId: task.ticketId, steps: plan(i) });
      ctx.emit({
        type: "run.thought",
        runId: ctx.runId,
        ticketId: task.ticketId,
        kind: "text",
        text: `${label}. (The mock agent only pretends; add a real agent to this column for real work.)`,
      });
      ctx.emit({
        type: "run.progress",
        runId: ctx.runId,
        ticketId: task.ticketId,
        role: "coder",
        label,
        fraction: (i + 1) / steps.length,
      });
      ctx.emit({
        type: "run.log",
        runId: ctx.runId,
        stream: "stdout",
        line: `[mock coder] ${label.toLowerCase()}`,
      });
      await sleep(350, ctx.signal);
    }

    ctx.emit({ type: "ticket.plan", ticketId: task.ticketId, steps: plan(steps.length) });

    const note = noteFor(task);
    await workspace.writeFile(note.path, note.contents);
    ctx.emit({
      type: "run.diff",
      runId: ctx.runId,
      path: note.path,
      patch: await workspace.diff(note.path).catch(() => ""),
    });

    return {
      ok: true,
      value: {
        summary: `${task.title} (mock run)`,
        detail:
          "Placeholder change written by the mock Coder Agent so the board can be driven end to end with no API key.",
        verifiedWith: null,
      },
      usage: MOCK_USAGE,
    };
  }
}

export class MockReviewerAgent implements ReviewerAgent {
  async fix(
    ctx: AgentContext,
    input: {
      task: CoderTask;
      workspace: Workspace;
      checks: FailingCheck[];
      attempt: number;
      maxAttempts: number;
    },
  ): Promise<AgentOutcome<CodeChange>> {
    ctx.emit({
      type: "run.progress",
      runId: ctx.runId,
      ticketId: input.task.ticketId,
      role: "reviewer",
      label: `Fixing ${input.checks[0]?.name ?? "CI"} (attempt ${input.attempt})`,
      fraction: input.attempt / input.maxAttempts,
    });
    await sleep(400, ctx.signal);

    const note = noteFor(input.task);
    await input.workspace.writeFile(
      note.path,
      `${note.contents}\n_Fix attempt ${input.attempt}._\n`,
    );

    return {
      ok: true,
      value: {
        summary: `Fix ${input.checks[0]?.name ?? "CI"} (mock run)`,
        detail: "Placeholder fix written by the mock Reviewer Agent.",
        verifiedWith: null,
      },
      usage: MOCK_USAGE,
    };
  }
}
