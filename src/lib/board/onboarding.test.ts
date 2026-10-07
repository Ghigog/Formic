import { beforeEach, describe, expect, it } from "vitest";

import { ONBOARDING_TICKET, addOnboardingTicket } from "./onboarding";
import { repository } from "@/lib/db";

/** A new board's first ticket: the AGENTS.md every later agent reads. */

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
});

describe("the onboarding ticket", () => {
  it("lands in To Do, ready to run, scoped to the agent instruction files", async () => {
    const repo = repository();
    const project = await repo.ensureProject({ ownerId: null, repoFullName: "acme/fresh", baseBranch: "main" });

    await addOnboardingTicket(project.id);

    const cards = await repo.boardCards(project.id);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({ kind: "ticket", status: "ready", title: ONBOARDING_TICKET.title });
    const detail = (await repo.ticketDetail(card.id))!;
    expect(detail.fileScope).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(detail.acceptanceCriteria).toHaveLength(2);
    expect(detail.description).toContain("@AGENTS.md");
  });
});
