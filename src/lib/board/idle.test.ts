import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCard } from "@/test/cards";

/** Every start the sweep made, in order, with the work it was handed. */
const launches = vi.hoisted(() => [] as Array<{ label: string; work: () => Promise<void> }>);
const productAgent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/agents/pipeline", () => ({
  launch: (work: () => Promise<void>, label: string) => launches.push({ label, work }),
  runProductAgent: productAgent,
}));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const { IDLE_AFTER_MS, resetIdleSweep, restartIdleCards, sweepIdleCards } = await import("./idle");
const { resetChatRecovery } = await import("@/lib/agents/recovery");
const { repository } = await import("@/lib/db");
const { seedMemory } = await import("@/lib/db/memory-repository");

const PROJECT = "project_default";
const NOW = Date.parse("2026-09-27T03:00:00Z");
const idle = new Date(NOW - IDLE_AFTER_MS - 1_000).toISOString();

/** What the sweep started, by label. */
const started = () => launches.map((l) => l.label);

beforeEach(() => {
  launches.length = 0;
  productAgent.mockClear();
  globalThis.__formicMemoryStore = undefined;
  resetIdleSweep();
  resetChatRecovery();
});

describe("restartIdleCards", () => {
  it("starts the Coder Agent on a card left running with nothing running it", async () => {
    const card = makeCard({ status: "running", stage: 6, prNumber: 133, updatedAt: idle });
    seedMemory([card]);

    await restartIdleCards(PROJECT, NOW);

    expect(started()).toEqual([`coder agent for ${card.key}, restarted`]);
  });

  it("reviews a card left in In Review with nothing reviewing it", async () => {
    const card = makeCard({ status: "review", stage: 6, prNumber: 133, updatedAt: idle });
    seedMemory([card]);

    await restartIdleCards(PROJECT, NOW);

    expect(started()).toEqual([`review for ${card.key}, restarted`]);
  });

  it("starts the Product Agent on an Epic left waiting in To Do for a PRD", async () => {
    const epic = makeCard({ kind: "epic", title: "Rework the intake flow", status: "waiting", updatedAt: idle });
    seedMemory([epic]);

    await restartIdleCards(PROJECT, NOW);

    expect(started()).toEqual([`product agent for ${epic.key}, restarted`]);
    // Briefed with the request it was made from, as any Product Agent is, so a
    // restarted one writes the PRD the person actually asked for.
    if (launches[0]) await launches[0].work();
    expect(productAgent).toHaveBeenCalledWith(PROJECT, epic.id, epic.title);
  });

  it("leaves an Epic whose PRD is already written, and one parked in Backlog", async () => {
    const specified = makeCard({ kind: "epic", status: "waiting", updatedAt: idle });
    const parked = makeCard({ kind: "epic", status: "draft", updatedAt: idle });
    seedMemory([specified, parked]);
    // Straight into the store, as board/service.test.ts does: setEpicPrd would
    // move the card, and this is an Epic that already has its PRD.
    globalThis.__formicMemoryStore!.prds.set(specified.id, {
      summary: "s",
      problem: "p",
      scope: ["x"],
      successCriteria: ["y"],
    });

    await restartIdleCards(PROJECT, NOW);

    expect(started()).toEqual([]);
  });

  it("leaves an Epic whose PRD is being written, in Actions or in a run", async () => {
    const onGithub = makeCard({ kind: "epic", status: "waiting", updatedAt: idle });
    const inRun = makeCard({
      kind: "epic",
      status: "waiting",
      updatedAt: idle,
      workingSince: new Date(NOW - 60_000).toISOString(),
    });
    seedMemory([onGithub, inRun]);
    await repository().setEpicRunnerJob(onGithub.id, "job-1", null);

    await restartIdleCards(PROJECT, NOW);

    expect(started()).toEqual([]);
  });

  it("leaves a card whose start may still be on its way", async () => {
    seedMemory([
      makeCard({ status: "running", updatedAt: new Date(NOW - 10_000).toISOString() }),
      makeCard({ kind: "epic", status: "waiting", updatedAt: new Date(NOW - 10_000).toISOString() }),
    ]);

    await restartIdleCards(PROJECT, NOW);

    expect(started()).toEqual([]);
  });

  it("leaves a card whose agent is working in GitHub Actions", async () => {
    const card = makeCard({ status: "running", updatedAt: idle });
    seedMemory([card], { [card.id]: { description: "", acceptanceCriteria: [] } });
    await repository().updateTicket(card.id, { runnerJob: "job-1" });

    await restartIdleCards(PROJECT, NOW);

    expect(started()).toEqual([]);
  });

  it("restarts a card once per idle spell", async () => {
    seedMemory([makeCard({ status: "running", updatedAt: idle })]);

    await restartIdleCards(PROJECT, NOW);
    resetIdleSweep();
    await restartIdleCards(PROJECT, NOW + 60_000);

    expect(started()).toHaveLength(1);
  });

  it("leaves cards that wait on a person or on nothing", async () => {
    seedMemory([
      makeCard({ status: "running", needsHuman: "Needs a key.", updatedAt: idle }),
      makeCard({ kind: "epic", status: "waiting", needsHuman: "Which epic?", updatedAt: idle }),
      makeCard({ status: "ready", updatedAt: idle }),
      makeCard({ status: "blocked", stalledIn: "in_progress", updatedAt: idle }),
    ]);

    await restartIdleCards(PROJECT, NOW);

    expect(started()).toEqual([]);
  });
});

describe("sweepIdleCards", () => {
  it("fails a card chat answer nothing is behind, so its chat takes questions again", async () => {
    const epic = makeCard({ kind: "epic" });
    seedMemory([epic]);
    const repo = repository();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const pending = await repo.addCardChatMessage({
        projectId: PROJECT,
        cardKind: "epic",
        cardId: epic.id,
        role: "assistant",
        content: "",
        status: "pending",
      });
      // Long enough ago that no function could still be writing it.
      vi.setSystemTime(NOW + 11 * 60_000);

      await sweepIdleCards(PROJECT);

      expect(await repo.cardChatMessage(pending.id)).toMatchObject({ status: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });
});
