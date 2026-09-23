import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCard, makeEpicWithChildren } from "@/test/cards";

const launched = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/agents/pipeline", () => ({
  launch: (_work: unknown, label: string) => launched.push(label),
  decomposeEpic: vi.fn(),
  runProductAgent: vi.fn(),
}));
vi.mock("@/lib/coder/pipeline", () => ({ runCoderAgent: vi.fn() }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const { applyTransition } = await import("./service");
const { repository } = await import("@/lib/db");
const { seedMemory } = await import("@/lib/db/memory-repository");

const PROJECT = "project_default";

beforeEach(() => {
  launched.length = 0;
  globalThis.__formicMemoryStore = undefined;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL;
});

describe("applyTransition within one column", () => {
  it("reorders an epic in To Do without re-running its Architect Agent", async () => {
    const [epic, child] = makeEpicWithChildren({ status: "ready" }, [{}]);
    const other = makeCard({ kind: "epic", status: "ready", size: null });
    seedMemory([epic!, child!, other]);
    // Straight into the store: setEpicPrd would move it back to Backlog.
    globalThis.__formicMemoryStore!.prds.set(epic!.id, {
      summary: "s",
      problem: "p",
      scope: ["x"],
      successCriteria: ["y"],
    });

    const result = await applyTransition(PROJECT, {
      cardId: epic!.id,
      kind: "epic",
      from: "todo",
      to: "todo",
      position: other.position + 1,
      actor: "user",
    });

    expect(result).toMatchObject({ ok: true, status: "ready" });
    expect(launched).toEqual([]);
  });

  it("keeps a specified backlog epic specified when nudged", async () => {
    const epic = makeCard({ kind: "epic", status: "specified", size: null });
    seedMemory([epic, makeCard({ kind: "epic", status: "draft", size: null })]);

    await applyTransition(PROJECT, {
      cardId: epic.id,
      kind: "epic",
      from: "backlog",
      to: "backlog",
      position: 1e9,
      actor: "user",
    });

    expect((await repository().cardById(epic.id))?.status).toBe("specified");
  });

  it("detaches a ticket from its epic in place", async () => {
    const [epic, child] = makeEpicWithChildren({ status: "ready" }, [{}]);
    seedMemory([epic!, child!]);

    const result = await applyTransition(PROJECT, {
      cardId: child!.id,
      kind: "ticket",
      from: "todo",
      to: "todo",
      position: 1e9,
      detached: true,
      actor: "user",
    });

    expect(result.ok).toBe(true);
    const moved = await repository().cardById(child!.id);
    expect(moved).toMatchObject({ status: "ready", detached: true });
    expect(launched).toEqual([]);
  });
});

describe("applyTransition of an epic into To Do", () => {
  const PRD = { summary: "s", problem: "p", scope: ["x"], successCriteria: ["y"] };
  const drop = (id: string) =>
    applyTransition(PROJECT, {
      cardId: id,
      kind: "epic",
      from: "backlog",
      to: "todo",
      position: 1e9,
      actor: "user",
    });

  it("starts the Architect Agent when the PRD is written", async () => {
    const epic = makeCard({ kind: "epic", status: "specified", size: null });
    seedMemory([epic]);
    globalThis.__formicMemoryStore!.prds.set(epic.id, PRD);

    const result = await drop(epic.id);

    expect(result).toMatchObject({ ok: true, status: "ready" });
    expect(launched).toEqual([`architect agent for ${epic.key}`]);
  });

  it("holds an epic whose PRD is still being written, without an agent yet", async () => {
    const epic = makeCard({ kind: "epic", status: "draft", size: null });
    seedMemory([epic]);

    const result = await drop(epic.id);

    expect(result).toMatchObject({ ok: true, status: "waiting" });
    expect(launched).toEqual([]);
    expect((await repository().cardById(epic.id))?.status).toBe("waiting");
  });

  it("refuses an epic whose Product Agent stalled with no PRD", async () => {
    const epic = makeCard({
      kind: "epic",
      status: "failed",
      stalledIn: "backlog",
      size: null,
    });
    seedMemory([epic]);

    const result = await drop(epic.id);

    expect(result).toMatchObject({ ok: false, revertTo: "backlog" });
    expect(launched).toEqual([]);
  });
});

describe("applyTransition into a column whose agent is out of usage", () => {
  it("refuses the move and says when the agent is back", async () => {
    const epic = makeCard({ kind: "epic", status: "specified", size: null });
    seedMemory([epic]);
    const repo = repository();
    const preset = await repo.savePreset({
      name: "Claude (work)",
      provider: "claude-code",
      model: "",
      prompt: "",
      apiKeyCipher: null,
    });
    await repo.setColumnAgent(PROJECT, "todo", preset.id);
    await repo.setPresetLimit(preset.id, { until: new Date(Date.now() + 3_600_000), note: "limit" });

    const result = await applyTransition(PROJECT, {
      cardId: epic.id,
      kind: "epic",
      from: "backlog",
      to: "todo",
      position: 1,
      actor: "user",
    });

    expect(result).toMatchObject({ ok: false, revertTo: "backlog" });
    expect(result.ok ? "" : result.reason).toContain("Claude (work) is out of usage until");
    expect(launched).toEqual([]);
  });
});
