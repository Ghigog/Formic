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
vi.mock("@/lib/coder/pipeline", () => ({ runCoderAgent: vi.fn(), stallTicket: vi.fn(), taskFor: vi.fn() }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const { applyTransition } = await import("./service");
const { blockerOf, startQueued, widenClaim } = await import("./queue");
const { withLease, LeaseBusy } = await import("./lease");
const { repository } = await import("@/lib/db");
const { seedMemory } = await import("@/lib/db/memory-repository");

const PROJECT = "project_default";

/** An agent on In Progress, so tickets moved there start rather than being refused. */
async function staffInProgress() {
  const repo = repository();
  const preset = await repo.savePreset({ name: "Coder", provider: "claude-code", model: "", prompt: "", apiKeyCipher: null });
  await repo.setColumnAgent(PROJECT, "in_progress", preset.id);
}

beforeEach(async () => {
  launched.length = 0;
  globalThis.__formicMemoryStore = undefined;
  await staffInProgress();
});

/** Alice's board on the same repository as the demo board, with one ticket running on `scope`. */
async function hersRunning(scope: string[]) {
  const repo = repository();
  const ours = await repo.defaultProject();
  const alice = await repo.upsertUser({ githubId: 7, login: "alice", name: null, avatarUrl: null });
  const hers = await repo.ensureProject({ ownerId: alice.id, repoFullName: ours.repoFullName.toUpperCase(), baseBranch: "main" });
  const epic = await repo.createEpic({ projectId: hers.id, title: "Hers", rawRequest: "Hers", position: 1 });
  const [ticket] = await repo.createTickets([
    {
      epicId: epic.id,
      key: "HER-1",
      title: "Router",
      description: "Router",
      acceptanceCriteria: [],
      fileScope: scope,
      size: "S",
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  await repo.updateTicket(ticket!.id, { status: "running" });
  return { hers, ticket: ticket! };
}

describe("files reserved across every board on a repository", () => {
  it("queues a ticket behind one running on someone else's board, and names it", async () => {
    const [epic, mine] = makeEpicWithChildren({ status: "ready" }, [{ status: "ready", fileScope: ["src/api/router.ts"] }]);
    seedMemory([epic!, mine!]);
    const { ticket } = await hersRunning(["src/api"]);

    const result = await applyTransition(PROJECT, {
      cardId: mine!.id,
      kind: "ticket",
      from: "todo",
      to: "in_progress",
      position: 1e9,
      actor: "user",
    });

    expect(result).toMatchObject({ ok: true, status: "queued" });
    expect(launched).toEqual([]);
    expect(await blockerOf(PROJECT, (await repository().cardById(mine!.id))!)).toMatchObject({
      ticketId: ticket.id,
      ownerLogin: "alice",
    });
    // The board can only see its own cards, so the card says who it waits on.
    expect((await repository().cardById(mine!.id))?.blockedReason).toContain("HER-1 on @alice's board");
  });

  it("starts the queued ticket once the one on the other board stops", async () => {
    const [epic, mine] = makeEpicWithChildren({ status: "ready" }, [{ status: "queued", fileScope: ["src/api"] }]);
    seedMemory([epic!, mine!]);
    const { hers, ticket } = await hersRunning(["src/api/router.ts"]);

    await startQueued(PROJECT);
    expect((await repository().cardById(mine!.id))).toMatchObject({
      status: "queued",
      blockedReason: expect.stringContaining("HER-1 on @alice's board"),
    });

    await repository().updateTicket(ticket.id, { status: "review" });
    // Her ticket stopping is what moves the queue on, from her board's events.
    await startQueued(hers.id);
    expect((await repository().cardById(mine!.id))).toMatchObject({ status: "running", blockedReason: null });
    expect(launched).toEqual([`coder agent for ${mine!.key}`]);
  });

  it("starts a ticket at once when the running one on the other board writes other files", async () => {
    const [epic, mine] = makeEpicWithChildren({ status: "ready" }, [{ status: "ready", fileScope: ["src/ui"] }]);
    seedMemory([epic!, mine!]);
    await hersRunning(["src/api"]);

    const result = await applyTransition(PROJECT, {
      cardId: mine!.id,
      kind: "ticket",
      from: "todo",
      to: "in_progress",
      position: 1e9,
      actor: "user",
    });
    expect(result).toMatchObject({ ok: true, status: "running" });
    expect(launched).toEqual([`coder agent for ${mine!.key}`]);
  });

  it("will not widen a running ticket's scope onto files another board holds", async () => {
    const [epic, mine] = makeEpicWithChildren({ status: "ready" }, [{ status: "running", fileScope: ["src/ui"] }]);
    seedMemory([epic!, mine!]);
    await hersRunning(["src/api"]);
    const write = vi.fn(async () => undefined);

    expect(await widenClaim(PROJECT, { id: mine!.id, fileScope: ["src/api/router.ts"] }, write)).toBe(false);
    expect(await widenClaim(PROJECT, { id: mine!.id, fileScope: ["src/lib"] }, write)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("a ticket sent back from review", () => {
  it("waits its turn when another board's ticket is writing its files, keeping its count of reviews", async () => {
    const { sendBack } = await import("@/lib/review/pipeline");
    const [epic, mine] = makeEpicWithChildren({ status: "ready" }, [{ status: "review", fileScope: ["src/api"], prNumber: 9 }]);
    seedMemory([epic!, mine!], { [mine!.id]: { description: "API", acceptanceCriteria: [] } });
    await repository().updateTicket(mine!.id, { attempts: 2 });
    const { hers, ticket } = await hersRunning(["src/api/router.ts"]);

    await sendBack(PROJECT, (await repository().ticketDetail(mine!.id))!, "Handle the empty case.");
    expect((await repository().cardById(mine!.id))?.status).toBe("queued");
    expect(launched).toEqual([]);

    await repository().updateTicket(ticket.id, { status: "review" });
    await startQueued(hers.id);
    expect((await repository().cardById(mine!.id))?.status).toBe("running");
    expect((await repository().ticketDetail(mine!.id))?.attempts).toBe(2);
    expect(launched).toEqual([`coder agent for ${mine!.key}`]);
  });
});

describe("withLease", () => {
  it("runs one holder at a time and lets the next in when it is done", async () => {
    const order: string[] = [];
    const slow = withLease("k", async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a:end");
    });
    const fast = withLease("k", async () => void order.push("b"));
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  it("gives up with LeaseBusy when another instance keeps holding it", async () => {
    await repository().acquireLease("held", "another instance", 60_000);
    await expect(withLease("held", async () => "never", { waitMs: 100 })).rejects.toBeInstanceOf(LeaseBusy);
  });

  it("lets go when the work throws", async () => {
    await expect(withLease("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withLease("k", async () => "next")).toBe("next");
  });
});

describe("the colony's cap", () => {
  it("holds routine work at the reserve, and lets a bug through", async () => {
    const [epic, a, b, bug] = makeEpicWithChildren({ status: "ready" }, [
      { status: "running", fileScope: ["src/a.ts"] },
      { status: "queued", fileScope: ["src/b.ts"] },
      { status: "queued", fileScope: ["src/c.ts"], workType: "bug" },
    ]);
    seedMemory([epic!, a!, b!, bug!]);
    // Two agents at once, at Lv 1, where the reserve floor is two: held to one.
    await repository().setColony(PROJECT, { colonySize: 2, colonyReserve: 1, autoScout: false });

    await startQueued(PROJECT);
    expect((await repository().cardById(b!.id))).toMatchObject({
      status: "queued",
      blockedReason: expect.stringContaining("The colony is full"),
    });
    expect((await repository().cardById(bug!.id))?.status).toBe("running");
    expect(launched).toEqual([`coder agent for ${bug!.key}`]);
  });

  it("changes nothing on a board with no cap", async () => {
    const [epic, a, b] = makeEpicWithChildren({ status: "ready" }, [
      { status: "running", fileScope: ["src/a.ts"] },
      { status: "queued", fileScope: ["src/b.ts"] },
    ]);
    seedMemory([epic!, a!, b!]);

    await startQueued(PROJECT);
    expect((await repository().cardById(b!.id))?.status).toBe("running");
  });

  it("calls back scouts the reserve sent on its own when urgent work needs the slots", async () => {
    const [epic, scouting, bug] = makeEpicWithChildren({ status: "ready" }, [
      { status: "running", fileScope: ["src/a.ts"], scouts: 2 },
      { status: "queued", fileScope: ["src/c.ts"], workType: "bug" },
    ]);
    seedMemory([epic!, scouting!, bug!], { [scouting!.id]: { description: "Spike", acceptanceCriteria: [] } });
    await repository().updateTicket(scouting!.id, { scoutWhy: "auto" });
    await repository().setColony(PROJECT, { colonySize: 2, colonyReserve: 1, autoScout: true });

    await startQueued(PROJECT);
    expect((await repository().cardById(scouting!.id))?.status).toBe("ready");
    expect((await repository().ticketDetail(scouting!.id))?.scouts).toBe(0);
    expect((await repository().cardById(bug!.id))?.status).toBe("running");
  });

  it("does not call back scouts a person sent", async () => {
    const [epic, scouting, bug] = makeEpicWithChildren({ status: "ready" }, [
      { status: "running", fileScope: ["src/a.ts"], scouts: 2 },
      { status: "queued", fileScope: ["src/c.ts"], workType: "bug" },
    ]);
    seedMemory([epic!, scouting!, bug!]);
    await repository().setColony(PROJECT, { colonySize: 2, colonyReserve: 1, autoScout: true });

    await startQueued(PROJECT);
    expect((await repository().cardById(scouting!.id))?.status).toBe("running");
    expect((await repository().cardById(bug!.id))?.status).toBe("queued");
  });
});

describe("critical and high bugs first", () => {
  const WAIT = "Waiting for critical and high bugs to be cleared first.";
  const get = async (id: string) => (await repository().cardById(id))!;

  it("starts a critical bug ahead of a routine ticket and holds the routine one", async () => {
    const routine = makeCard({ status: "queued", position: 1000 });
    const bug = makeCard({ status: "queued", position: 2000, workType: "bug", bugSeverity: "critical" });
    seedMemory([routine, bug]);

    await startQueued(PROJECT);

    expect(launched).toEqual([`coder agent for ${bug.key}`]);
    expect(await get(routine.id)).toMatchObject({ status: "queued", blockedReason: WAIT });
  });

  it("holds routine tickets while a high bug runs, then starts them on its own", async () => {
    const routine = makeCard({ status: "queued", position: 1000 });
    const bug = makeCard({ status: "running", position: 2000, workType: "bug", bugSeverity: "high" });
    seedMemory([routine, bug]);

    await startQueued(PROJECT);
    expect(launched).toEqual([]);
    expect(await get(routine.id)).toMatchObject({ status: "queued", blockedReason: WAIT });

    await repository().updateTicket(bug.id, { status: "review" });
    await startQueued(PROJECT);
    expect(await get(routine.id)).toMatchObject({ status: "running", blockedReason: null });
    expect(launched).toEqual([`coder agent for ${routine.key}`]);
  });

  it("holds nothing for a medium or low bug", async () => {
    const routine = makeCard({ status: "queued", position: 1000 });
    const bug = makeCard({ status: "queued", position: 2000, workType: "bug", bugSeverity: "medium" });
    seedMemory([routine, bug]);

    await startQueued(PROJECT);

    expect(launched.sort()).toEqual([`coder agent for ${routine.key}`, `coder agent for ${bug.key}`].sort());
  });
});
