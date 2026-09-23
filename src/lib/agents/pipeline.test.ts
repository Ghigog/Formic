import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCard } from "@/test/cards";

const deferred = vi.hoisted(() => [] as unknown[]);

vi.mock("next/server", () => ({ after: (work: unknown) => deferred.push(work) }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const { applyPrd } = await import("./pipeline");
const { repository } = await import("@/lib/db");
const { seedMemory } = await import("@/lib/db/memory-repository");

const PROJECT = "project_default";
const PRD = {
  summary: "s",
  problem: "p",
  scope: ["x"],
  outOfScope: [],
  technicalContext: [],
  userStories: [],
  successCriteria: ["y"],
};

beforeEach(() => {
  deferred.length = 0;
  globalThis.__formicMemoryStore = undefined;
});

describe("applyPrd", () => {
  it("leaves a backlog epic in Backlog, specified", async () => {
    const epic = makeCard({ kind: "epic", status: "draft", size: null });
    seedMemory([epic]);

    await applyPrd(PROJECT, epic.id, PRD);

    expect((await repository().cardById(epic.id))?.status).toBe("specified");
    expect(deferred).toHaveLength(0);
  });

  it("keeps an epic waiting in To Do there and starts its Architect Agent", async () => {
    const epic = makeCard({ kind: "epic", status: "waiting", size: null });
    seedMemory([epic]);

    await applyPrd(PROJECT, epic.id, PRD);

    expect((await repository().cardById(epic.id))?.status).toBe("ready");
    expect(deferred).toHaveLength(1);
  });
});
