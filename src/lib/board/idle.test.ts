import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCard } from "@/test/cards";

const launched = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/agents/pipeline", () => ({
  launch: (_work: unknown, label: string) => launched.push(label),
}));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const { IDLE_AFTER_MS, resetIdleSweep, restartIdleCards } = await import("./idle");
const { repository } = await import("@/lib/db");
const { seedMemory } = await import("@/lib/db/memory-repository");

const PROJECT = "project_default";
const NOW = Date.parse("2026-09-27T03:00:00Z");
const idle = new Date(NOW - IDLE_AFTER_MS - 1_000).toISOString();

beforeEach(() => {
  launched.length = 0;
  globalThis.__formicMemoryStore = undefined;
  resetIdleSweep();
});

describe("restartIdleCards", () => {
  it("starts the Coder Agent on a card left running with nothing running it", async () => {
    const card = makeCard({ status: "running", stage: 6, prNumber: 133, updatedAt: idle });
    seedMemory([card]);

    await restartIdleCards(PROJECT, NOW);

    expect(launched).toEqual([`coder agent for ${card.key}, restarted`]);
  });

  it("reviews a card left in In Review with nothing reviewing it", async () => {
    const card = makeCard({ status: "review", stage: 6, prNumber: 133, updatedAt: idle });
    seedMemory([card]);

    await restartIdleCards(PROJECT, NOW);

    expect(launched).toEqual([`review for ${card.key}, restarted`]);
  });

  it("leaves a card whose start may still be on its way", async () => {
    seedMemory([makeCard({ status: "running", updatedAt: new Date(NOW - 10_000).toISOString() })]);

    await restartIdleCards(PROJECT, NOW);

    expect(launched).toEqual([]);
  });

  it("leaves a card whose agent is working in GitHub Actions", async () => {
    const card = makeCard({ status: "running", updatedAt: idle });
    seedMemory([card], { [card.id]: { description: "", acceptanceCriteria: [] } });
    await repository().updateTicket(card.id, { runnerJob: "job-1" });

    await restartIdleCards(PROJECT, NOW);

    expect(launched).toEqual([]);
  });

  it("restarts a card once per idle spell", async () => {
    seedMemory([makeCard({ status: "running", updatedAt: idle })]);

    await restartIdleCards(PROJECT, NOW);
    resetIdleSweep();
    await restartIdleCards(PROJECT, NOW + 60_000);

    expect(launched).toHaveLength(1);
  });

  it("leaves cards that wait on a person or on nothing", async () => {
    seedMemory([
      makeCard({ status: "running", needsHuman: "Needs a key.", updatedAt: idle }),
      makeCard({ status: "ready", updatedAt: idle }),
      makeCard({ status: "blocked", stalledIn: "in_progress", updatedAt: idle }),
    ]);

    await restartIdleCards(PROJECT, NOW);

    expect(launched).toEqual([]);
  });
});
