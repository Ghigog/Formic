import { beforeEach, describe, expect, it, vi } from "vitest";

// Local mode, no cookies: the demo board is the active project.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const { runCoderAgent } = await import("./pipeline");
const { setCheckoutFactory } = await import("./checkout");
const { repository } = await import("@/lib/db");
const { resetAgents, setAgents } = await import("@/lib/agents/registry");
const mock = await import("@/lib/agents/mock");
const { resetMergeLanes } = await import("@/lib/review/lane");
const { MockVcsClient, resetVcs, setVcs } = await import("@/lib/vcs");
const route = await import("@/app/api/tickets/[id]/route");

/**
 * A ticket's own view, end to end on the in-memory store: an agent working
 * the ticket shares its plan and its thinking, and the view shows the ticket
 * as it was written alongside both.
 */

const PROJECT = "project_default";

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetMergeLanes();
  resetAgents();
  resetVcs();
  setCheckoutFactory(null);
  setVcs(new MockVcsClient("acme/widgets"));
  setAgents({
    product: new mock.MockProductAgent(),
    architect: new mock.MockArchitectAgent(),
    coder: new mock.MockCoderAgent(),
    reviewer: new mock.MockReviewerAgent(),
    showcase: new mock.MockShowcaseAgent(),
  });
});

async function view(id: string) {
  const res = await route.GET(new Request(`http://x/api/tickets/${id}`) as never, {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: await res.json() };
}

describe("a ticket's own view", () => {
  it("shows the ticket, the agent's plan and what it thought", async () => {
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "Export", rawRequest: "r", position: 1 });
    const [ticket] = await repo.createTickets([
      {
        epicId: epic.id,
        key: "T-1",
        title: "Export endpoint",
        description: "**User story:** As a board owner, I'd like a CSV.\n\n### Context\nWhy.",
        acceptanceCriteria: ["Given a board, when I export it, then I get a CSV."],
        fileScope: ["src/app/api/export"],
        size: "M",
        storyPoints: 5,
        position: 1,
        dependsOnKeys: [],
      },
    ]);

    await runCoderAgent(PROJECT, ticket!.id);
    // Plans are written in order behind the run; let the last one land.
    await new Promise((r) => setTimeout(r, 20));

    const { status, body } = await view(ticket!.id);
    expect(status).toBe(200);
    expect(body.card).toMatchObject({ key: "T-1", storyPoints: 5 });
    expect(body.epic).toMatchObject({ id: epic.id, title: "Export" });
    expect(body.description).toContain("### Context");
    expect(body.acceptanceCriteria).toHaveLength(1);
    expect(body.plan.length).toBeGreaterThan(0);
    expect(body.plan.every((s: { status: string }) => s.status === "done")).toBe(true);
    expect(body.activity.some((a: { kind: string }) => a.kind === "text")).toBe(true);
    expect(body.activity.some((a: { kind: string }) => a.kind === "action")).toBe(true);
  });

  it("is a 404 for a card that is not a ticket on this board", async () => {
    expect((await view("ticket_nope")).status).toBe(404);
  });
});
