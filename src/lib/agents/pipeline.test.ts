import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCard, makeEpicWithChildren } from "@/test/cards";

const deferred = vi.hoisted(() => [] as unknown[]);

vi.mock("next/server", () => ({ after: (work: unknown) => deferred.push(work) }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const { applyPrd, applyTickets } = await import("./pipeline");
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

describe("applyTickets on an Epic broken down again", () => {
  const draft = (key: string, dependsOn: string[] = []) => ({
    key,
    title: key,
    description: "d",
    acceptanceCriteria: ["a"],
    fileScope: [`src/${key}`],
    size: "S" as const,
    dependsOn,
  });

  it("replaces the tickets nobody started, keeps the rest, and renames clashing keys", async () => {
    const [epic, idle, busy] = makeEpicWithChildren({ status: "ready" }, [
      { key: "T-1", status: "ready" },
      { key: "T-2", status: "review", prNumber: 7 },
    ]);
    seedMemory([epic!, idle!, busy!]);

    await applyTickets(PROJECT, epic!.id, [draft("T-1"), draft("T-2", ["T-1"])]);

    const tickets = await repository().ticketsForEpic(epic!.id);
    expect(tickets.map((t) => t.key).sort()).toEqual(["T-1", "T-2", "T-2-2"]);
    expect(tickets.some((t) => t.id === idle!.id)).toBe(false);
    expect(tickets.some((t) => t.id === busy!.id)).toBe(true);
    const renamed = (await repository().boardCards(PROJECT)).find((c) => c.key === "T-2-2")!;
    const first = tickets.find((t) => t.key === "T-1")!;
    expect(renamed.dependsOn).toEqual([first.id]);
  });
});

describe("applyPrd on an Epic already broken down in To Do", () => {
  it("keeps it in To Do and breaks it down again", async () => {
    const epic = makeCard({ kind: "epic", status: "ready", size: null });
    seedMemory([epic]);

    await applyPrd(PROJECT, epic.id, PRD, true);

    expect((await repository().cardById(epic.id))?.status).toBe("ready");
    expect(deferred).toHaveLength(1);
  });
});
