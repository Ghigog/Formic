import type { PlanStep, BoardCard } from "@/lib/domain/entities";
import type { CardExtras } from "@/components/board/card";
import type { AmbientStats } from "@/components/ui/ambient-drawer";

/**
 * The demo board.
 *
 * Content follows design/artboards/Main.html: the same epics, ticket ids, log
 * lines, commits and PR numbers. Where the artboard shows the same ticket in
 * two columns at once — it is a mockup, and the brief says the ids are sample
 * data — the fixture keeps one card per ticket and moves it, so the board is
 * internally consistent while every card anatomy still has something to draw:
 * a backlog epic and a raw idea, a To Do DAG with one unlocked and one
 * blocked child, two running cards, a failing and a passing review, and a
 * merged group.
 */

/** An ISO time `days` ago, so the demo timeline always ends today. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function card(
  partial: Partial<BoardCard> &
    Pick<BoardCard, "id" | "key" | "title" | "status">,
): BoardCard {
  return {
    kind: "ticket",
    stalledIn: null,
    stage: 1,
    position: 0,
    epicId: null,
    size: "M",
    storyPoints: 3,
    agentRole: null,
    model: null,
    fileScope: [],
    dependsOn: [],
    prNumber: null,
    prUrl: null,
    blockedReason: null,
    costCents: 0,
    childCount: 0,
    doneCount: 0,
    ...partial,
  };
}

export const FIXTURE_CARDS: BoardCard[] = [
  /* ---- Backlog --------------------------------------------------------- */
  card({
    id: "epic-4",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    kind: "epic",
    key: "EPIC-04",
    title: "Concurrent merge queue",
    status: "specified",
    stage: 2,
    position: 1000,
    size: null,
    agentRole: "product",
    model: "claude-opus-5",
  }),
  card({
    id: "idea-1",
    createdAt: daysAgo(0.1),
    updatedAt: daysAgo(0.1),
    key: "RAW-07",
    title: "Swipe between columns on mobile instead of drag-and-drop",
    status: "draft",
    stage: 1,
    position: 2000,
    size: null,
  }),
  card({
    id: "idea-2",
    createdAt: daysAgo(0.3),
    updatedAt: daysAgo(0.3),
    key: "RAW-08",
    title: "Ambient drawer flickers when the terminal opens",
    status: "draft",
    stage: 1,
    position: 3000,
    size: null,
  }),

  /* ---- To Do ----------------------------------------------------------- */
  card({
    id: "epic-3",
    createdAt: daysAgo(6),
    updatedAt: daysAgo(4),
    kind: "epic",
    key: "EPIC-03",
    title: "Agentic execution loop",
    status: "ready",
    stage: 3,
    position: 1000,
    size: null,
    childCount: 6,
    doneCount: 0,
    agentRole: "architect",
    model: "claude-opus-5",
  }),
  card({
    id: "prot-7",
    createdAt: daysAgo(4),
    updatedAt: daysAgo(4),
    key: "PROT-07",
    title: "Reviewer webhook",
    status: "ready",
    stage: 3,
    position: 1100,
    epicId: "epic-3",
    size: "M",
    storyPoints: 3,
    fileScope: ["agents/reviewer/**"],
  }),
  card({
    id: "prot-8",
    createdAt: daysAgo(4),
    updatedAt: daysAgo(4),
    key: "PROT-08",
    title: "Showcase aggregator",
    status: "waiting",
    stage: 3,
    position: 1200,
    epicId: "epic-3",
    size: "S",
    storyPoints: 2,
    fileScope: ["agents/pm/**"],
    dependsOn: ["prot-7"],
    blockedReason: "blocked by PROT-07",
  }),

  /* ---- In Progress ----------------------------------------------------- */
  card({
    id: "prot-6",
    createdAt: daysAgo(4),
    startedAt: daysAgo(0.2),
    updatedAt: daysAgo(0.2),
    key: "PROT-06",
    title: "Implement Coder Agent execution loop",
    status: "running",
    stage: 5,
    position: 1000,
    epicId: "epic-3",
    size: "M",
    storyPoints: 3,
    fileScope: ["agents/coder/**"],
    agentRole: "coder",
    model: "claude-sonnet-5",
    costCents: 88,
  }),
  card({
    id: "prot-5",
    createdAt: daysAgo(4),
    startedAt: daysAgo(0.05),
    updatedAt: daysAgo(0.05),
    key: "PROT-05",
    title: "Set up E2B sandbox environment",
    status: "running",
    stage: 4,
    position: 2000,
    epicId: "epic-3",
    size: "S",
    storyPoints: 2,
    fileScope: ["services/sandbox/**"],
    agentRole: "coder",
    model: "claude-sonnet-5",
    costCents: 21,
  }),

  /* ---- In Review ------------------------------------------------------- */
  card({
    id: "prot-3",
    createdAt: daysAgo(4),
    startedAt: daysAgo(3),
    updatedAt: daysAgo(1),
    key: "PROT-03",
    title: "Build Backlog “Product Agent” pipeline",
    status: "review",
    stage: 6,
    position: 1000,
    epicId: "epic-3",
    size: "M",
    storyPoints: 3,
    fileScope: ["agents/product/**"],
    agentRole: "reviewer",
    model: "claude-sonnet-5",
    prNumber: 118,
    prUrl: "https://github.com/formic-labs/formic-web/pull/118",
    costCents: 64,
  }),
  card({
    id: "prot-4",
    createdAt: daysAgo(4),
    startedAt: daysAgo(2),
    updatedAt: daysAgo(0.5),
    key: "PROT-04",
    title: "Build To Do “Architect Agent” pipeline",
    status: "review",
    stage: 7,
    position: 2000,
    epicId: "epic-3",
    size: "L",
    storyPoints: 8,
    fileScope: ["agents/architect/**"],
    agentRole: "reviewer",
    model: "claude-sonnet-5",
    prNumber: 117,
    prUrl: "https://github.com/formic-labs/formic-web/pull/117",
    costCents: 96,
  }),

  /* ---- Done ------------------------------------------------------------ */
  card({
    id: "epic-1",
    createdAt: daysAgo(9),
    updatedAt: daysAgo(5),
    kind: "epic",
    key: "EPIC-01",
    title: "Board foundations",
    status: "merged",
    stage: 8,
    position: 1000,
    size: null,
    childCount: 2,
    doneCount: 2,
  }),
  card({
    id: "prot-1",
    createdAt: daysAgo(9),
    startedAt: daysAgo(8),
    updatedAt: daysAgo(6),
    key: "PROT-01",
    title: "Next.js + Kanban UI",
    status: "merged",
    stage: 8,
    position: 1100,
    epicId: "epic-1",
    size: "M",
    storyPoints: 3,
    fileScope: ["src/components/board/**"],
    prNumber: 114,
    prUrl: "https://github.com/formic-labs/formic-web/pull/114",
    costCents: 131,
  }),
  card({
    id: "prot-2",
    createdAt: daysAgo(9),
    startedAt: daysAgo(7),
    updatedAt: daysAgo(5),
    key: "PROT-02",
    title: "Database + persistence",
    status: "merged",
    stage: 8,
    position: 1200,
    epicId: "epic-1",
    size: "M",
    storyPoints: 3,
    fileScope: ["prisma/**", "src/lib/db/**"],
    prNumber: 116,
    prUrl: "https://github.com/formic-labs/formic-web/pull/116",
    costCents: 118,
  }),
];

/** Display-only detail for the demo board. See CardExtras. */
export const FIXTURE_EXTRAS: Record<string, CardExtras> = {
  "epic-4": {
    summary:
      "Lift the one-PR-at-a-time limit: file-scope locks plus an ordered rebase queue.",
    stageLabel: "PRD draft",
  },
  "idea-1": { age: "2h ago" },
  "idea-2": { age: "7h ago" },
  "epic-3": { dagSummary: "DAG ready · 6 tickets · 2 file scopes locked" },
  "prot-6": {
    elapsed: "04:12",
    sandboxId: "E2B · sbx_8f2a41",
    progress: { label: "Running vitest · 13/21 files", fraction: 0.62 },
  },
  "prot-5": {
    elapsed: "00:48",
    progress: { label: "Cloning formic-web · 28%", fraction: 0.28 },
  },
  "prot-3": {
    ci: "failing",
    checks: { passed: 10, failed: 2 },
    reviewState: "Fix loop · try 2",
    logExcerpt: ["FAIL app/api/epics/route.test.ts", "expected 200, received 500"],
  },
  "prot-4": {
    ci: "passing",
    checks: { passed: 12, failed: 0 },
    reviewState: "Rebase queued · 1st",
    diffstat: "+284 / −12 · 9 files",
  },
  "prot-1": { mergeCommit: "4a91c07" },
  "prot-2": { mergeCommit: "8d3e2b1" },
};

/** What the ambient drawer reports on the demo board. */
export const FIXTURE_STATS: Omit<AmbientStats, "provider"> = {
  activeSandboxes: 2,
  tokensIn: 141_200,
  tokensOut: 41_200,
  costCents: 214,
  throughput: 1900,
  queueDepth: 2,
  mergeLockPr: 117,
  logLines: [],
};

/**
 * What the demo's tickets in progress say, written to the ticket template,
 * and the plans their agents are part way through, so a ticket's own view
 * has something to show before any agent has run.
 */
export const FIXTURE_TICKET_DETAILS: Record<
  string,
  { description: string; acceptanceCriteria: string[]; plan: PlanStep[] }
> = {
  "prot-6": {
    description: [
      "**User story:** As a board owner, I'd like a ticket in In Progress to be implemented by an agent, so that I only step in to review.",
      "",
      "### Context",
      "Tickets reach In Progress with a scope and acceptance criteria, but nothing works them yet.",
      "",
      "### Description",
      "A Coder Agent loop that reads the ticket, edits files inside its scope, runs the checks and hands back a change.",
      "",
      "### Requirements",
      "- Tools: `bash`, `read_file`, `write_file`, `str_replace`, `finish`",
      "- Writes outside the file scope are refused",
      "- The run stops at its budget and says so",
    ].join("\n"),
    acceptanceCriteria: [
      "Given a ready ticket, when it moves to In Progress, then an agent opens a pull request for it.",
      "Given the agent writes outside its scope, when the change is checked, then nothing is pushed and the card says why.",
    ],
    plan: [
      { step: "Read the ticket and the files in agents/coder", status: "done" },
      { step: "Define the tool set and its schemas", status: "done" },
      { step: "Write the loop that runs tool calls", status: "in_progress" },
      { step: "Refuse writes outside the file scope", status: "pending" },
      { step: "Run the checks and finish", status: "pending" },
    ],
  },
  "prot-5": {
    description: [
      "**User story:** As a Coder Agent, I'd like a clean sandbox per ticket, so that my work cannot touch anyone else's.",
      "",
      "### Context",
      "Agents need somewhere to run commands that is not the server.",
      "",
      "### Description",
      "An E2B sandbox minted per run, with the repository checked out on the ticket's branch.",
      "",
      "### Requirements",
      "- One sandbox per run, torn down when it ends",
      "- The person's own E2B key, never the server's",
    ].join("\n"),
    acceptanceCriteria: [
      "Given a run starts, when the sandbox is ready, then the repository is checked out on the ticket's branch.",
    ],
    plan: [
      { step: "Mint a sandbox with the person's key", status: "done" },
      { step: "Check the branch out", status: "in_progress" },
      { step: "Tear it down when the run ends", status: "pending" },
    ],
  },
};
