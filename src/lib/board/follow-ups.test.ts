import { beforeEach, describe, expect, it } from "vitest";

import { addFollowUpTicket, answerFollowUp, nextTicketKey, recordFollowUps } from "./follow-ups";
import { repository } from "@/lib/db";
import type { FollowUp } from "@/lib/agents/follow-ups";

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
    { title: "Raise branch coverage to 78%", why: "About 540 branches are uncovered.", points: 5, need: "nice" },
    { title: "Fix order-dependent tests", why: "They fail when shuffled.", points: null, need: "nice" },
  ]);
  return { epic, ticket: ticket! };
}

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
});

describe("recordFollowUps", () => {
  it("adds to what the ticket had, without repeats", async () => {
    const { ticket } = await seed();
    await recordFollowUps(ticket.id, [{ title: "Fix order-dependent tests", why: "Again.", points: 1, need: "nice" }]);
    const followUps = (await repository().ticketDetail(ticket.id))!.followUps;
    expect(followUps.map((f) => f.title)).toEqual(["Raise branch coverage to 78%", "Fix order-dependent tests"]);
  });
});

describe("recordFollowUps triage", () => {
  const needed: FollowUp = { title: "Add the missing index", why: "Slow query.", points: 2, need: "needed" };

  it("creates a needed follow-up at once and records its key", async () => {
    const { epic, ticket } = await seed();
    await recordFollowUps(ticket.id, [needed]);
    const repo = repository();
    const added = (await repo.ticketsForEpic(epic.id)).find((t) => t.key === `${epic.key}-T2`)!;
    expect(added.title).toBe("Add the missing index");
    const rec = (await repo.ticketDetail(ticket.id))!.followUps.find((f) => f.title === needed.title)!;
    expect(rec.outcome).toEqual({ kind: "added", key: `${epic.key}-T2`, cardId: added.id });
  });

  it("creates no ticket for a nice one and stores it as pending", async () => {
    const { epic, ticket } = await seed();
    expect((await repository().ticketsForEpic(epic.id)).length).toBe(1);
    const followUps = (await repository().ticketDetail(ticket.id))!.followUps;
    expect(followUps.every((f) => f.outcome?.kind === "pending")).toBe(true);
  });

  it("does not create a repeated needed follow-up twice", async () => {
    const { epic, ticket } = await seed();
    await recordFollowUps(ticket.id, [needed]);
    await recordFollowUps(ticket.id, [needed]);
    expect((await repository().ticketsForEpic(epic.id)).length).toBe(2);
  });

  it("makes a standalone ticket from a standalone one", async () => {
    const repo = repository();
    const holder = await repo.createEpic({ projectId: PROJECT, title: "Solo", rawRequest: "Solo", position: 1 });
    await repo.setStandalone(holder.id, true);
    const [t] = await repo.createTickets([
      { epicId: holder.id, key: "T-1", title: "Solo", description: "", acceptanceCriteria: [], fileScope: [], storyPoints: 1, position: 1, dependsOnKeys: [] },
    ]);
    await recordFollowUps(t!.id, [needed]);
    const rec = (await repo.ticketDetail(t!.id))!.followUps[0]!;
    expect(rec.outcome).toMatchObject({ kind: "added" });
    expect((rec.outcome as { key: string }).key).toMatch(/^T-\d+$/);
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

describe("addFollowUpTicket", () => {
  const followUp: FollowUp = { title: "Tidy the seams", why: "They leak.", points: 3, need: "nice" };

  it("gives a standalone source a standalone ticket of its own at the end of To Do", async () => {
    const repo = repository();
    const holder = await repo.createEpic({ projectId: PROJECT, title: "Alone", rawRequest: "Alone", position: 1 });
    await repo.setStandalone(holder.id, true);
    const [source] = await repo.createTickets([
      {
        epicId: holder.id,
        key: `T-${await repo.nextStandaloneTicketNumber(PROJECT)}`,
        title: "Alone",
        description: "",
        acceptanceCriteria: [],
        fileScope: ["src/a.ts"],
        storyPoints: null,
        position: 1,
        dependsOnKeys: [],
      },
    ]);
    const detail = (await repo.ticketDetail(source!.id))!;

    const card = await addFollowUpTicket(PROJECT, detail, followUp);

    expect(card.key).toBe("T-2");
    expect(card.epicId).not.toBe(holder.id);
    const added = (await repo.ticketDetail(card.id))!;
    expect(added).toMatchObject({ status: "ready", workType: "tech_debt", fileScope: ["src/a.ts"], storyPoints: 3 });
    expect((await repo.cardById(card.epicId!))?.standalone).toBe(true);
    const todo = await repo.columnPositions(PROJECT, "todo");
    expect(card.position).toBeGreaterThanOrEqual(Math.max(...todo));
  });

  it("keeps a source on a real Epic on that Epic", async () => {
    const { epic, ticket } = await seed();
    const card = await addFollowUpTicket(PROJECT, (await repository().ticketDetail(ticket.id))!, followUp);
    expect(card.key).toBe(`${epic.key}-T2`);
    expect(card.epicId).toBe(epic.id);
  });
});
