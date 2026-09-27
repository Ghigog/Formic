import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCard, makeEpicWithChildren } from "@/test/cards";

const launched = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/agents/pipeline", () => ({
  launch: (_work: unknown, label: string) => launched.push(label),
  decomposeEpic: vi.fn(),
  runProductAgent: vi.fn(),
  runArchitectDraftTicket: vi.fn(),
  repoTree: vi.fn().mockResolvedValue([]),
  startRun: vi.fn(() => ({})),
  applyShowcase: vi.fn(),
}));
vi.mock("@/lib/coder/pipeline", () => ({ runCoderAgent: vi.fn() }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const { applyTransition, canRetryEpic, createTodoItem, deleteEpic, retryEpic } = await import(
  "./service"
);
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

  it("writes the PRD again for an epic whose Product Agent stalled", async () => {
    const epic = makeCard({
      kind: "epic",
      status: "failed",
      stalledIn: "backlog",
      size: null,
    });
    seedMemory([epic]);

    const result = await drop(epic.id);

    expect(result).toMatchObject({ ok: true, status: "waiting" });
    expect(launched).toEqual([`product agent for ${epic.key}`]);
  });

  it("gets an epic stuck in In Progress with no PRD back on track in To Do", async () => {
    const epic = makeCard({ kind: "epic", status: "running", size: null });
    seedMemory([epic]);

    const result = await applyTransition(PROJECT, {
      cardId: epic.id,
      kind: "epic",
      from: "in_progress",
      to: "todo",
      position: 1,
      actor: "user",
    });

    expect(result).toMatchObject({ ok: true, status: "waiting" });
    expect(launched).toEqual([`product agent for ${epic.key}`]);
  });
});

describe("applyTransition onto files another agent is writing", () => {
  it("queues the ticket in In Progress without starting its agent", async () => {
    const [epic, running, next] = makeEpicWithChildren({ status: "ready" }, [
      { status: "running", fileScope: ["src/ui"] },
      { status: "ready", fileScope: ["src/ui/button.tsx"] },
    ]);
    seedMemory([epic!, running!, next!]);

    const result = await applyTransition(PROJECT, {
      cardId: next!.id,
      kind: "ticket",
      from: "todo",
      to: "in_progress",
      position: 1e9,
      actor: "user",
    });

    expect(result).toMatchObject({ ok: true, status: "queued" });
    expect(result.ok && result.problem).toBeFalsy();
    expect(await repository().cardById(next!.id)).toMatchObject({ status: "queued", misplacedIn: null });
    expect(launched).toEqual([]);
  });
});

describe("applyTransition into a column whose agent is out of usage", () => {
  it("lands the card, marked with when the agent is back", async () => {
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

    expect(result).toMatchObject({ ok: true, status: "specified" });
    expect(result.ok ? result.problem : "").toContain("Claude (work) is out of usage until");
    expect(await repository().cardById(epic.id)).toMatchObject({
      status: "specified",
      misplacedIn: "todo",
    });
    expect(launched).toEqual([]);
  });
});

describe("dropping a card where it cannot work", () => {
  it("lands it there, keeps its status, and says how to fix it", async () => {
    const ticket = makeCard({ status: "ready" });
    seedMemory([ticket]);

    const result = await applyTransition(PROJECT, {
      cardId: ticket.id,
      kind: "ticket",
      from: "todo",
      to: "done",
      position: 1,
      actor: "user",
    });

    expect(result).toMatchObject({ ok: true, status: "ready" });
    expect(result.ok ? result.problem : "").toContain("Drag it back to To Do");
    expect(await repository().cardById(ticket.id)).toMatchObject({
      status: "ready",
      misplacedIn: "done",
    });
    expect(launched).toEqual([]);
  });

  it("clears the mark when it goes back where it belongs", async () => {
    const ticket = makeCard({ status: "ready", misplacedIn: "done", misplacedReason: "wrong" });
    seedMemory([ticket]);

    const result = await applyTransition(PROJECT, {
      cardId: ticket.id,
      kind: "ticket",
      from: "done",
      to: "todo",
      position: 1,
      actor: "user",
    });

    expect(result).toMatchObject({ ok: true, status: "ready", problem: null });
    expect(await repository().cardById(ticket.id)).toMatchObject({
      misplacedIn: null,
      misplacedReason: null,
    });
  });

  it("marks an epic dropped into In Progress, and starts nothing", async () => {
    const epic = makeCard({ kind: "epic", status: "ready", size: null });
    seedMemory([epic]);

    const result = await applyTransition(PROJECT, {
      cardId: epic.id,
      kind: "epic",
      from: "todo",
      to: "in_progress",
      position: 1,
      actor: "user",
    });

    expect(result.ok ? result.problem : "").toContain("its tickets are");
    expect(await repository().cardById(epic.id)).toMatchObject({ status: "ready", misplacedIn: "in_progress" });
    expect(launched).toEqual([]);
  });

  it("marks an epic dropped into Done while a ticket is still open", async () => {
    const [epic, ...kids] = makeEpicWithChildren({ status: "ready" }, [{ status: "merged" }, { status: "ready" }]);
    seedMemory([epic!, ...kids]);

    const result = await applyTransition(PROJECT, {
      cardId: epic!.id,
      kind: "epic",
      from: "todo",
      to: "done",
      position: 1,
      actor: "user",
    });

    expect(result.ok ? result.problem : "").toContain("its tickets are");
    expect(await repository().cardById(epic!.id)).toMatchObject({ status: "ready", misplacedIn: "done" });
  });
});

describe("an epic whose tickets have all merged", () => {
  it("goes to Done when dropped there, and gets its showcase written", async () => {
    const [epic, ...kids] = makeEpicWithChildren({ status: "ready" }, [{ status: "merged" }, { status: "merged" }]);
    seedMemory([epic!, ...kids]);

    const result = await applyTransition(PROJECT, {
      cardId: epic!.id,
      kind: "epic",
      from: "todo",
      to: "done",
      position: 1,
      actor: "user",
    });

    expect(result).toMatchObject({ ok: true, status: "merged" });
    expect(await repository().cardById(epic!.id)).toMatchObject({ status: "merged", misplacedIn: null });
    expect(launched).toEqual([`showcase for epic ${epic!.id}`]);
  });

  it("keeps a showcase it already has", async () => {
    const [epic, ...kids] = makeEpicWithChildren({ status: "ready" }, [{ status: "merged" }]);
    seedMemory([epic!, ...kids]);
    globalThis.__formicMemoryStore!.showcases.set(epic!.id, "Shipped.");

    await applyTransition(PROJECT, {
      cardId: epic!.id,
      kind: "epic",
      from: "todo",
      to: "done",
      position: 1,
      actor: "user",
    });

    expect((await repository().cardById(epic!.id))?.status).toBe("merged");
    expect(launched).toEqual([]);
  });
});

describe("retrying a stalled Epic", () => {
  it("runs the Product Agent again for one that never got its PRD", async () => {
    const epic = makeCard({
      kind: "epic",
      status: "blocked",
      stalledIn: "backlog",
      stage: 2,
      size: null,
      blockedReason: "This Epic has nothing to work from yet.",
    });
    seedMemory([epic]);

    expect(await retryEpic(PROJECT, epic.id)).toEqual({ ok: true });

    const after = await repository().cardById(epic.id);
    expect(after).toMatchObject({ status: "draft", stalledIn: null, blockedReason: null });
    expect(launched).toEqual([`product agent for ${epic.key}`]);
  });

  it("breaks one down again when it has its PRD and sits in To Do", async () => {
    const epic = makeCard({ kind: "epic", status: "failed", stalledIn: "todo", stage: 3, size: null });
    seedMemory([epic]);
    globalThis.__formicMemoryStore!.prds.set(epic.id, {
      summary: "s",
      problem: "p",
      scope: ["x"],
      successCriteria: ["y"],
    });

    expect(await retryEpic(PROJECT, epic.id)).toEqual({ ok: true });

    expect(await repository().cardById(epic.id)).toMatchObject({ status: "ready", stalledIn: null });
    expect(launched).toEqual([`architect agent for ${epic.key}`]);
  });

  it("leaves one alone while its agent is still working", async () => {
    const epic = makeCard({ kind: "epic", status: "draft", size: null, updatedAt: new Date().toISOString() });
    seedMemory([epic]);

    expect(await retryEpic(PROJECT, epic.id)).toMatchObject({ ok: false, status: 409 });
    expect(launched).toEqual([]);
  });

  it("counts a draft with no PRD, gone quiet for a while, as stuck", () => {
    const epic = makeCard({ kind: "epic", status: "draft", size: null, updatedAt: "2026-01-01T00:00:00Z" });
    expect(canRetryEpic(epic, { prd: null, runnerJob: null })).toBe(true);
    // A job on GitHub Actions gets its whole hour first.
    const recent = { ...epic, updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() };
    expect(canRetryEpic(recent, { prd: null, runnerJob: "job-1" })).toBe(false);
    expect(canRetryEpic(epic, { prd: null, runnerJob: "job-1" })).toBe(true);
  });
});

describe("deleting an Epic", () => {
  it("removes it with its tickets", async () => {
    const [epic, a, b] = makeEpicWithChildren({ status: "ready" }, [{}, { status: "waiting" }]);
    seedMemory([epic!, a!, b!]);

    expect(await deleteEpic(PROJECT, epic!.id)).toEqual({ ok: true });

    expect(await repository().boardCards(PROJECT)).toEqual([]);
  });

  it("refuses while one of its tickets is running", async () => {
    const [epic, a] = makeEpicWithChildren({ status: "ready" }, [{ status: "running" }]);
    seedMemory([epic!, a!]);

    const result = await deleteEpic(PROJECT, epic!.id);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok ? "" : result.reason).toContain(a!.key);
    expect(await repository().cardById(epic!.id)).not.toBeNull();
  });
});

describe("an Epic's tickets following it", () => {
  const PRD_DOC = { summary: "s", problem: "p", scope: ["x"], successCriteria: ["y"] };
  const move = (id: string, from: "todo" | "backlog", to: "todo" | "backlog") =>
    applyTransition(PROJECT, { cardId: id, kind: "epic", from, to, position: 1e9, actor: "user" });

  it("takes its unstarted tickets back to Backlog, and leaves the rest", async () => {
    const [epic, idle, pulled, busy] = makeEpicWithChildren({ status: "ready" }, [
      { status: "ready" },
      { status: "ready", detached: true },
      { status: "running" },
    ]);
    seedMemory([epic!, idle!, pulled!, busy!]);
    globalThis.__formicMemoryStore!.prds.set(epic!.id, PRD_DOC);

    await move(epic!.id, "todo", "backlog");

    const repo = repository();
    expect(await repo.cardById(epic!.id)).toMatchObject({ status: "specified" });
    expect((await repo.cardById(idle!.id))?.status).toBe("draft");
    expect((await repo.cardById(pulled!.id))?.status).toBe("ready");
    expect((await repo.cardById(busy!.id))?.status).toBe("running");
  });

  it("brings them back to To Do as they were when the PRD has not changed", async () => {
    const [epic, a, b] = makeEpicWithChildren({ status: "specified" }, [
      { status: "draft", createdAt: new Date().toISOString() },
      { status: "draft", createdAt: new Date().toISOString() },
    ]);
    b!.dependsOn = [a!.id];
    seedMemory([epic!, a!, b!]);
    const s = globalThis.__formicMemoryStore!;
    s.prds.set(epic!.id, PRD_DOC);
    s.prdTimes.set(epic!.id, new Date(Date.now() - 60_000));

    await move(epic!.id, "backlog", "todo");

    const repo = repository();
    expect((await repo.cardById(a!.id))?.status).toBe("ready");
    expect((await repo.cardById(b!.id))?.status).toBe("waiting");
    expect(launched).toEqual([]);
  });

  it("breaks it down again when the PRD changed since they were made", async () => {
    const [epic, a] = makeEpicWithChildren({ status: "specified" }, [
      { status: "draft", createdAt: new Date(Date.now() - 60_000).toISOString() },
    ]);
    seedMemory([epic!, a!]);
    const s = globalThis.__formicMemoryStore!;
    s.prds.set(epic!.id, PRD_DOC);
    s.prdTimes.set(epic!.id, new Date());

    await move(epic!.id, "backlog", "todo");

    expect(launched).toEqual([`architect agent for ${epic!.key}`]);
  });
});

describe("createTodoItem", () => {
  it("creates a blocked, detached ticket under a standalone holder Epic and drafts it", async () => {
    const card = await createTodoItem(PROJECT, "  Fix the broken footer link.  ");

    expect(card.kind).toBe("ticket");
    expect(card.status).toBe("blocked");
    expect(card.stalledIn).toBe("todo");
    expect(card.blockedReason).toBe("Drafting the ticket…");
    expect(card.detached).toBe(true);

    // The holder Epic never renders as its own card.
    const cards = await repository().boardCards(PROJECT);
    expect(cards).toEqual([expect.objectContaining({ id: card.id, kind: "ticket" })]);

    expect(launched).toEqual([`architect agent for ${card.key}`]);
  });

  it("places the ticket after whatever else is already in To Do", async () => {
    const existing = makeCard({ kind: "ticket", status: "ready" });
    seedMemory([existing]);

    const card = await createTodoItem(PROJECT, "Add a retry button.");

    expect(card.position).toBeGreaterThan(existing.position);
  });

  it("claims attachments uploaded against the request id, a no-op with none yet", async () => {
    const card = await createTodoItem(PROJECT, "Add a retry button.", "req-1");

    expect(await repository().attachmentsFor({ ticketId: card.id })).toEqual([]);
  });
});
