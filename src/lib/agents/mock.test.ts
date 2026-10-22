import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MockArchitectAgent,
  MockCoderAgent,
  MockProductAgent,
  MockReviewerAgent,
  MockShowcaseAgent,
} from "./mock";
import type { AgentContext, CoderTask, ReviewTask } from "./ports";
import type { Prd } from "@/lib/domain/entities";
import type { FormicEvent } from "@/lib/domain/events";
import { MemoryWorkspace } from "@/lib/sandbox/workspace";

function context(signal = new AbortController().signal) {
  const events: FormicEvent[] = [];
  const ctx: AgentContext = { runId: "run-1", projectId: "p", emit: (e) => events.push(e), signal };
  return { ctx, events };
}

/** Lets the agent's fake sleeps elapse, then returns what it produced. */
async function settled<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return work;
}

const TASK: CoderTask = {
  ticketId: "t1",
  key: "T-7",
  title: "Add a thing",
  description: "Do the thing.",
  acceptanceCriteria: ["It works"],
  fileScope: ["src/lib/thing"],
};

const PRD: Prd = {
  summary: "Sum",
  problem: "P",
  scope: [],
  outOfScope: [],
  technicalContext: [],
  userStories: [],
  successCriteria: [],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the mock Product Agent", () => {
  it("streams a PRD titled from the request and ends the stream", async () => {
    const { ctx, events } = context();

    const out = await settled(
      new MockProductAgent().draftPrd(ctx, { epicId: "e1", rawRequest: "let people share boards. Really.", attachments: [] }),
    );

    expect(out.ok && out.value.kind === "prd" && out.value.title).toBe("Let people share boards");
    const prd = events.filter((e) => e.type === "epic.prd");
    expect(prd.length).toBeGreaterThan(1);
    expect(prd.at(-1)).toMatchObject({ done: true });
  });

  it("reroutes a request that says to", async () => {
    const { ctx } = context();

    const out = await new MockProductAgent().draftPrd(ctx, { epicId: "e1", rawRequest: "Please reroute this", attachments: [] });

    expect(out.ok && out.value.kind).toBe("reroute");
  });

  it("stops when cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    const { ctx } = context(abort.signal);

    await expect(
      new MockProductAgent().draftPrd(ctx, { epicId: "e1", rawRequest: "Something", attachments: [] }),
    ).rejects.toThrow("aborted");
  });

  it("stops when cancelled while waiting", async () => {
    const abort = new AbortController();
    const { ctx } = context(abort.signal);
    const work = new MockProductAgent().draftPrd(ctx, { epicId: "e1", rawRequest: "Something", attachments: [] });
    const failed = expect(work).rejects.toThrow("aborted");

    abort.abort();

    await failed;
  });
});

describe("the mock Architect Agent", () => {
  it("decomposes into a dependency chain with two concurrent tickets", async () => {
    const { ctx, events } = context();

    const out = await settled(new MockArchitectAgent().decompose(ctx, { epicId: "e1", title: "Sharing", prd: PRD, repoTree: [] }));

    expect(out.ok && out.value.map((t) => t.key)).toEqual(["T-1", "T-2", "T-3", "T-4"]);
    expect(events.filter((e) => e.type === "run.progress")).toHaveLength(3);
  });

  it("drafts one ticket from a request", async () => {
    const { ctx } = context();

    const out = await settled(new MockArchitectAgent().draftTicket(ctx, { rawRequest: "fix the footer", repoTree: [], attachments: [] }));

    expect(out.ok && out.value.kind === "ticket" && out.value.ticket.title).toBe("Fix the footer");
  });
});

describe("the mock Showcase Agent", () => {
  it("writes a showcase from the epic and announces it", async () => {
    const { ctx, events } = context();

    const out = await settled(
      new MockShowcaseAgent().summarize(ctx, {
        epicId: "e1",
        title: "Sharing",
        prd: PRD,
        ticketSummaries: [{ key: "T-1", title: "Schema", summary: "s" }],
      }),
    );

    expect(out.ok && out.value).toContain("Sharing is live: Sum");
    expect(out.ok && out.value).toContain("2. Look for schema.");
    expect(events).toContainEqual(expect.objectContaining({ type: "epic.showcase", epicId: "e1" }));
  });

  it("copes with an epic with no PRD", async () => {
    const { ctx } = context();

    const out = await settled(new MockShowcaseAgent().summarize(ctx, { epicId: "e1", title: "X", prd: null, ticketSummaries: [] }));

    expect(out.ok && out.value).toContain("the board does what you asked for");
  });
});

describe("the mock Coder Agent", () => {
  it("walks its plan and leaves a note inside the ticket's scope", async () => {
    const { ctx, events } = context();
    const workspace = new MemoryWorkspace();

    const out = await settled(new MockCoderAgent().implement(ctx, { task: TASK, workspace }));

    expect(out.ok && out.value.summary).toBe("Add a thing (mock run)");
    expect(await workspace.readFile("src/lib/thing/t-7.md")).toContain("- [x] It works");
    const plans = events.filter((e) => e.type === "ticket.plan");
    expect(plans).toHaveLength(5);
    expect(events).toContainEqual(expect.objectContaining({ type: "run.diff", path: "src/lib/thing/t-7.md" }));
  });
});

describe("the mock Reviewer Agent", () => {
  const review = (checks: ReviewTask["checks"]): ReviewTask => ({
    task: TASK,
    workspace: new MemoryWorkspace(),
    checks,
    attempt: 1,
    maxAttempts: 3,
    baseBranch: "main",
    changedFiles: [],
  } as unknown as ReviewTask);

  it("approves when CI is green", async () => {
    const { ctx } = context();

    const out = await settled(new MockReviewerAgent().review(ctx, review([])));

    expect(out.ok && out.value.summary).toBe("Approved (mock run)");
  });

  it("writes a fix when a check is red", async () => {
    const { ctx } = context();
    const input = review([{ name: "lint", summary: "", annotations: [] }]);

    const out = await settled(new MockReviewerAgent().review(ctx, input));

    expect(out.ok && out.value.summary).toBe("Fix lint (mock run)");
    expect(await input.workspace.readFile("src/lib/thing/t-7.md")).toContain("Fix from review 1");
  });

  it("picks the candidate that changes the fewest files", async () => {
    const { ctx } = context();

    const out = await settled(
      new MockReviewerAgent().compare(ctx, {
        task: TASK,
        candidates: [
          { label: "A", files: ["a", "b"] },
          { label: "B", files: ["a"] },
        ] as never,
      }),
    );

    expect(out.ok && out.value.pick).toBe("B");
  });
});
