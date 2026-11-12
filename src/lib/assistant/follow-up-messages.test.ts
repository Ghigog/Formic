import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async () => 1) }));
vi.mock("server-only", () => ({}));

import { recordFollowUps } from "@/lib/board/follow-ups";
import { repository } from "@/lib/db";
import { applyAction } from "./actions";
import { proposeFollowUps } from "./follow-up-messages";

const PROJECT = "project_default";

async function seed(standalone = false) {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Coverage", rawRequest: "Raise it", position: 1 });
  if (standalone) await repo.setStandalone(epic.id, true);
  const [ticket] = await repo.createTickets([
    {
      epicId: epic.id,
      key: standalone ? "T-1" : `${epic.key}-T3`,
      title: "Raise thresholds",
      description: "d",
      acceptanceCriteria: [],
      fileScope: ["a.ts"],
      storyPoints: 2,
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  await recordFollowUps(ticket!.id, [
    { title: "Raise branch coverage", why: "Many uncovered.", points: 3, need: "nice" },
    { title: "Add the index", why: "Slow.", points: 2, need: "needed" },
  ]);
  return ticket!;
}

const messages = async () => (await repository().assistantMessages(PROJECT)).messages;

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
});

describe("proposeFollowUps", () => {
  it("posts one message with the nice one as a proposal and the needed one as a card", async () => {
    const ticket = await seed();
    await proposeFollowUps(PROJECT, ticket.id);
    const [m, ...rest] = await messages();
    expect(rest).toEqual([]);
    expect(m!.content).toContain(`${ticket.key} · Raise thresholds is done`);
    expect(m!.proposals).toEqual([
      {
        summary: "Add ticket: Raise branch coverage (3 pt)",
        action: { type: "add_follow_up", ticket: ticket.key, title: "Raise branch coverage" },
        state: "proposed",
      },
    ]);
    expect(m!.cards).toHaveLength(1);
    expect(m!.cards[0]!.title).toBe("Add the index");
    const f = (await repository().ticketDetail(ticket.id))!.followUps;
    expect(f[0]!.outcome).toEqual({ kind: "proposed", messageId: m!.id });
  });

  it("posts nothing the second time, or when there are no follow-ups", async () => {
    const ticket = await seed();
    await proposeFollowUps(PROJECT, ticket.id);
    await proposeFollowUps(PROJECT, ticket.id);
    expect(await messages()).toHaveLength(1);

    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "E2", rawRequest: "r", position: 2 });
    const [bare] = await repo.createTickets([
      { epicId: epic.id, key: `${epic.key}-T1`, title: "t", description: "d", acceptanceCriteria: [], fileScope: [], position: 1, dependsOnKeys: [] },
    ]);
    await proposeFollowUps(PROJECT, bare!.id);
    expect(await messages()).toHaveLength(1);
  });
});

describe("applyAction add_follow_up", () => {
  it("adds the ticket to the Epic and records it as added", async () => {
    const ticket = await seed();
    await proposeFollowUps(PROJECT, ticket.id);
    const done = await applyAction(PROJECT, { type: "add_follow_up", ticket: ticket.key, title: "Raise branch coverage" });
    expect(done).toMatch(/^Added .+-T\d+\.$/);
    const f = (await repository().ticketDetail(ticket.id))!.followUps[0]!;
    expect(f.outcome).toMatchObject({ kind: "added" });
    await expect(
      applyAction(PROJECT, { type: "add_follow_up", ticket: ticket.key, title: "Raise branch coverage" }),
    ).rejects.toThrow(/already decided/);
  });

  it("makes a standalone ticket from a standalone source", async () => {
    const ticket = await seed(true);
    expect(await applyAction(PROJECT, { type: "add_follow_up", ticket: ticket.key, title: "Raise branch coverage" })).toMatch(
      /^Added T-\d+\.$/,
    );
  });
});
