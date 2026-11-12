import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async () => 1) }));
vi.mock("server-only", () => ({}));

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { reportStall, resetStallsReported } from "./stall-messages";

const PROJECT = "project_default";

async function seed() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Coverage", rawRequest: "Raise it", position: 1 });
  const [ticket] = await repo.createTickets([
    { epicId: epic.id, key: `${epic.key}-T1`, title: "Raise thresholds", description: "d", acceptanceCriteria: [], fileScope: [], position: 1, dependsOnKeys: [] },
  ]);
  return ticket!;
}

const stall = (cardId: string, status: string, blockedReason: string | null): FormicEvent => ({
  type: "card.status",
  cardId,
  kind: "ticket",
  status,
  stalledIn: "in_progress",
  stage: 1,
  blockedReason,
});

const messages = async () => (await repository().assistantMessages(PROJECT)).messages;

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  resetStallsReported();
});

describe("reportStall", () => {
  it("posts a question stall once, naming the card and linking it", async () => {
    const t = await seed();
    const e = stall(t.id, "blocked", "Question: Which database?");
    await reportStall(PROJECT, e);
    await reportStall(PROJECT, e);
    const all = await messages();
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toContain(`${t.key} · Raise thresholds needs you: Question for you. Which database?`);
    expect(all[0]!.content).toContain("Answer in the card's chat.");
    expect(all[0]!.cards).toEqual([{ id: t.id, key: t.key, title: "Raise thresholds" }]);
  });

  it("posts what is wrong for a Stuck stall", async () => {
    const t = await seed();
    await reportStall(PROJECT, stall(t.id, "blocked", "Run stuck: no new commits for 30 minutes\nCoder: tests"));
    const [m] = await messages();
    expect(m!.content).toContain("needs you: Stuck. Run stuck: no new commits for 30 minutes");
    expect(m!.content).toContain("Coder: tests");
  });

  it("posts again when the reason changes", async () => {
    const t = await seed();
    await reportStall(PROJECT, stall(t.id, "blocked", "Question: A?"));
    await reportStall(PROJECT, stall(t.id, "blocked", "Question: B?"));
    expect(await messages()).toHaveLength(2);
  });

  it("posts nothing for a usage-limit stop", async () => {
    const t = await seed();
    await reportStall(PROJECT, stall(t.id, "blocked", "Usage limit reached\nresets at noon"));
    expect(await messages()).toHaveLength(0);
  });
});
