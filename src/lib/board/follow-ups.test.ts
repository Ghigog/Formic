import { beforeEach, describe, expect, it } from "vitest";

import { answerFollowUp, nextTicketKey, recordFollowUps } from "./follow-ups";
import { repository } from "@/lib/db";

const PROJECT = "project_default";

async function seed() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Coverage", rawRequest: "Raise it", position: 1 });
  const [ticket] = await repo.createTickets([
    {
      epicId: epic.id,
      key: `${epic.key}-T1`,
      title: "Raise thresholds",
      description: "Set them to measured.",
      acceptanceCriteria: ["Thresholds are within 3 points"],
      fileScope: ["vitest.config.ts"],
      storyPoints: 2,
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  await recordFollowUps(ticket!.id, [
    { title: "Raise branch coverage to 78%", why: "About 540 branches are uncovered.", points: 5 },
    { title: "Fix order-dependent tests", why: "They fail when shuffled.", points: null },
  ]);
  return { epic, ticket: ticket! };
}

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
});

describe("recordFollowUps", () => {
  it("adds to what the ticket had, without repeats", async () => {
    const { ticket } = await seed();
    await recordFollowUps(ticket.id, [{ title: "Fix order-dependent tests", why: "Again.", points: 1 }]);
    const followUps = (await repository().ticketDetail(ticket.id))!.followUps;
    expect(followUps.map((f) => f.title)).toEqual(["Raise branch coverage to 78%", "Fix order-dependent tests"]);
  });
});

describe("answerFollowUp", () => {
  it("adds one as a tech debt ticket on the same Epic and takes it off the list", async () => {
    const { epic, ticket } = await seed();
    const answer = await answerFollowUp(PROJECT, ticket.id, 0, true);
    expect(answer).toEqual({ ok: true, message: `Added ${epic.key}-T2.` });

    const repo = repository();
    const added = (await repo.ticketsForEpic(epic.id)).find((t) => t.key === `${epic.key}-T2`)!;
    expect(added).toMatchObject({
      title: "Raise branch coverage to 78%",
      workType: "tech_debt",
      storyPoints: 5,
      fileScope: ["vitest.config.ts"],
    });
    expect(added.description).toContain("About 540 branches are uncovered.");
    expect(added.description).toContain(`Found while working on ${ticket.key}.`);
    expect((await repo.ticketDetail(ticket.id))!.followUps.map((f) => f.title)).toEqual(["Fix order-dependent tests"]);
  });

  it("dismisses one without adding a ticket", async () => {
    const { epic, ticket } = await seed();
    expect(await answerFollowUp(PROJECT, ticket.id, 1, false)).toEqual({ ok: true, message: "Dismissed." });
    const repo = repository();
    expect(await repo.ticketsForEpic(epic.id)).toHaveLength(1);
    expect((await repo.ticketDetail(ticket.id))!.followUps).toHaveLength(1);
  });

  it("refuses one that is no longer there", async () => {
    const { ticket } = await seed();
    expect(await answerFollowUp(PROJECT, ticket.id, 5, true)).toEqual({
      ok: false,
      error: "That follow-up is no longer there.",
    });
  });
});

describe("nextTicketKey", () => {
  it("follows the Epic's highest ticket number", () => {
    expect(nextTicketKey("EPIC-9", ["EPIC-9-T1", "EPIC-9-T7", "EPIC-9-T3-2", "EPIC-10-T20"])).toBe("EPIC-9-T8");
    expect(nextTicketKey("EPIC-9", [])).toBe("EPIC-9-T1");
  });
});
