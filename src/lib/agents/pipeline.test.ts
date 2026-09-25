import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCard, makeEpicWithChildren } from "@/test/cards";
import type {
  AgentContext,
  AgentOutcome,
  ArchitectAgent,
  DraftTicket,
  ExistingTicket,
  ProductAgent,
} from "@/lib/agents/ports";
import {
  MockCoderAgent,
  MockProductAgent,
  MockReviewerAgent,
  MockShowcaseAgent,
} from "@/lib/agents/mock";

const deferred = vi.hoisted(() => [] as unknown[]);

vi.mock("next/server", () => ({ after: (work: unknown) => deferred.push(work) }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const { applyPrd, applyTickets, decomposeEpic, runArchitectDraftTicket, runProductAgent } =
  await import("./pipeline");
const { repository } = await import("@/lib/db");
const { seedMemory } = await import("@/lib/db/memory-repository");
const { resetAgents, setAgents } = await import("./registry");

const NO_USAGE = { model: "stub", tokensIn: 0, tokensOut: 0, costCents: 0 };

/** An Architect Agent whose draftTicket does whatever the test tells it to. */
class StubArchitect implements ArchitectAgent {
  constructor(
    private readonly outcome: (
      input: { rawRequest: string },
    ) => Promise<
      AgentOutcome<{ kind: "ticket"; ticket: DraftTicket } | { kind: "reroute"; reason: string }>
    >,
  ) {}

  async decompose(): Promise<AgentOutcome<DraftTicket[]>> {
    throw new Error("not used");
  }

  async draftTicket(
    _ctx: AgentContext,
    input: { rawRequest: string },
  ): Promise<
    AgentOutcome<{ kind: "ticket"; ticket: DraftTicket } | { kind: "reroute"; reason: string }>
  > {
    return this.outcome(input);
  }
}

function useArchitect(architect: ArchitectAgent) {
  setAgents({
    product: new MockProductAgent(),
    architect,
    coder: new MockCoderAgent(),
    reviewer: new MockReviewerAgent(),
    showcase: new MockShowcaseAgent(),
  });
}

/** A Product Agent whose draftPrd does whatever the test tells it to. */
class StubProduct implements ProductAgent {
  constructor(private readonly outcome: () => ReturnType<ProductAgent["draftPrd"]>) {}

  async draftPrd(..._args: Parameters<ProductAgent["draftPrd"]>): ReturnType<ProductAgent["draftPrd"]> {
    return this.outcome();
  }
}

function useProduct(product: ProductAgent) {
  setAgents({
    product,
    architect: new (class implements ArchitectAgent {
      async decompose(): Promise<AgentOutcome<DraftTicket[]>> {
        throw new Error("not used");
      }
      async draftTicket(): Promise<never> {
        throw new Error("not used");
      }
    })(),
    coder: new MockCoderAgent(),
    reviewer: new MockReviewerAgent(),
    showcase: new MockShowcaseAgent(),
  });
}

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

afterEach(() => {
  resetAgents();
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

  it("leaves a record in the Epic's chat of what it replaced and kept", async () => {
    const [epic, idle, busy] = makeEpicWithChildren({ status: "ready" }, [
      { key: "T-1", status: "ready" },
      { key: "T-2", status: "review", prNumber: 7 },
    ]);
    seedMemory([epic!, idle!, busy!]);

    await applyTickets(PROJECT, epic!.id, [draft("T-1"), draft("T-2", ["T-1"])]);

    const messages = await repository().cardChatMessages(epic!.id);
    const record = messages.find((m) => m.role === "assistant");
    expect(record?.status).toBe("done");
    expect(record?.content).toContain("Replaced T-1 (");
    expect(record?.content).toContain("Kept T-2, already in flight.");
  });

  it("leaves no record on the very first decomposition", async () => {
    const [epic] = makeEpicWithChildren({ status: "ready" }, []);
    seedMemory([epic!]);

    await applyTickets(PROJECT, epic!.id, [draft("T-1")]);

    expect(await repository().cardChatMessages(epic!.id)).toEqual([]);
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

describe("runArchitectDraftTicket", () => {
  const draftedTicket: DraftTicket = {
    key: "T-1",
    title: "Add the missing button",
    description: "Add the button the raw request asked for.",
    acceptanceCriteria: ["The button appears where the request says"],
    fileScope: ["src/components/button"],
    size: "S",
    storyPoints: 2,
    dependsOn: [],
  };

  const seedDrafting = () => {
    const [epic, ticket] = makeEpicWithChildren(
      { status: "draft", standalone: true, size: null },
      [
        {
          key: "T-1",
          status: "blocked",
          stalledIn: "todo",
          blockedReason: "Drafting the ticket…",
          detached: true,
          fileScope: [],
        },
      ],
    );
    seedMemory([epic!, ticket!]);
    return { epic: epic!, ticket: ticket! };
  };

  it("fills in the drafted ticket and clears the block on success", async () => {
    const { epic, ticket } = seedDrafting();
    useArchitect(
      new StubArchitect(async () => ({
        ok: true,
        value: { kind: "ticket", ticket: draftedTicket },
        usage: NO_USAGE,
      })),
    );

    await runArchitectDraftTicket(PROJECT, epic.id, ticket.id, "raw request text", []);

    const cards = await repository().boardCards(PROJECT);
    const drafted = cards.find((c) => c.epicId === epic.id && c.kind === "ticket");
    expect(drafted).toBeDefined();
    expect(drafted?.title).toBe(draftedTicket.title);
    expect(drafted?.fileScope).toEqual(draftedTicket.fileScope);
    expect(drafted?.size).toBe(draftedTicket.size);
    expect(drafted?.storyPoints).toBe(draftedTicket.storyPoints);
    expect(drafted?.status).toBe("ready");
    expect(drafted?.blockedReason).toBeNull();
    expect(drafted?.detached).toBe(true);

    const detail = await repository().ticketDetail(drafted!.id);
    expect(detail?.description).toBe(draftedTicket.description);
    expect(detail?.acceptanceCriteria).toEqual(draftedTicket.acceptanceCriteria);
  });

  it("stalls the ticket blocked in To Do when the run fails", async () => {
    const { epic, ticket } = seedDrafting();
    useArchitect(
      new StubArchitect(async () => ({
        ok: false,
        error: "The model declined to draft this ticket.",
        blocked: true,
        usage: NO_USAGE,
      })),
    );

    await runArchitectDraftTicket(PROJECT, epic.id, ticket.id, "raw request text", []);

    const card = await repository().cardById(ticket.id);
    expect(card?.status).toBe("blocked");
    expect(card?.stalledIn).toBe("todo");
    expect(card?.blockedReason).toBe("The model declined to draft this ticket.");
  });

  it("reroutes back to Backlog for a PRD when the Architect Agent answers reroute", async () => {
    const { epic, ticket } = seedDrafting();
    useArchitect(
      new StubArchitect(async () => ({
        ok: true,
        value: { kind: "reroute", reason: "Too big for one ticket; needs a PRD." },
        usage: NO_USAGE,
      })),
    );

    await runArchitectDraftTicket(PROJECT, epic.id, ticket.id, "raw request text", []);

    const cards = await repository().boardCards(PROJECT);
    expect(cards.some((c) => c.id === ticket.id)).toBe(false);
    const rerouted = cards.find((c) => c.id === epic.id)!;
    expect(rerouted).toMatchObject({
      kind: "epic",
      status: "draft",
      rerouteFrom: "todo",
      rerouteReason: "Too big for one ticket; needs a PRD.",
      standalone: false,
    });
    expect(rerouted.blockedReason).toBeNull();
  });
});

describe("runProductAgent, given a reroute answer", () => {
  const draftedTicket: DraftTicket = {
    key: "T-1",
    title: "Add the missing button",
    description: "Add the button the raw request asked for.",
    acceptanceCriteria: ["The button appears where the request says"],
    fileScope: ["src/components/button"],
    size: "S",
    storyPoints: 2,
    dependsOn: [],
  };

  it("moves a Backlog request into To Do as the drafted ticket, not stalled", async () => {
    const epic = makeCard({ kind: "epic", status: "draft", size: null });
    seedMemory([epic]);
    useProduct(
      new StubProduct(async () => ({
        ok: true,
        value: { kind: "reroute", reason: "Small enough for one ticket.", ticket: draftedTicket },
        usage: NO_USAGE,
      })),
    );

    await runProductAgent(PROJECT, epic.id, "Add the missing button please");

    const cards = await repository().boardCards(PROJECT);
    expect(cards.some((c) => c.id === epic.id)).toBe(false);
    const drafted = cards.find((c) => c.epicId === epic.id && c.kind === "ticket")!;
    expect(drafted).toMatchObject({
      title: draftedTicket.title,
      fileScope: draftedTicket.fileScope,
      size: draftedTicket.size,
      storyPoints: draftedTicket.storyPoints,
      status: "ready",
      rerouteFrom: "backlog",
      rerouteReason: "Small enough for one ticket.",
      detached: true,
    });
    expect(drafted.blockedReason).toBeNull();

    const detail = await repository().ticketDetail(drafted.id);
    expect(detail?.description).toBe(draftedTicket.description);
    expect(detail?.acceptanceCriteria).toEqual(draftedTicket.acceptanceCriteria);
  });
});

describe("decomposeEpic, asked to break an Epic down again", () => {
  it("passes the person's notes and the current tickets to the Architect Agent", async () => {
    const [epic, idle] = makeEpicWithChildren({ status: "ready" }, [{ key: "T-1", status: "ready" }]);
    seedMemory([epic!, idle!]);
    await repository().setEpicPrd(epic!.id, PRD, true);
    // publish() is mocked in this file, so the note is appended directly
    // rather than through addEpicNote, which would otherwise call it.
    await repository().appendEvent(PROJECT, "epic.note", {
      type: "epic.note",
      epicId: epic!.id,
      text: "Split T-1 into two.",
    });

    let seen: { existing?: ExistingTicket[]; instructions?: string[] } = {};
    setAgents({
      product: new MockProductAgent(),
      architect: {
        async decompose(_ctx, input) {
          seen = { existing: input.existing, instructions: input.instructions };
          return { ok: true, value: [], usage: NO_USAGE };
        },
        async draftTicket(): Promise<never> {
          throw new Error("not used");
        },
      },
      coder: new MockCoderAgent(),
      reviewer: new MockReviewerAgent(),
      showcase: new MockShowcaseAgent(),
    });

    await decomposeEpic(PROJECT, epic!.id);

    expect(seen.instructions).toEqual(["Split T-1 into two."]);
    expect(seen.existing?.map((t) => t.key)).toEqual(["T-1"]);
    expect(seen.existing?.[0]?.inFlight).toBe(false);
  });

  it("asks nothing extra on a first decomposition, with no notes yet", async () => {
    const [epic] = makeEpicWithChildren({ status: "ready" }, []);
    seedMemory([epic!]);
    await repository().setEpicPrd(epic!.id, PRD, true);

    let seen: { existing?: ExistingTicket[]; instructions?: string[] } = {};
    setAgents({
      product: new MockProductAgent(),
      architect: {
        async decompose(_ctx, input) {
          seen = { existing: input.existing, instructions: input.instructions };
          return { ok: true, value: [], usage: NO_USAGE };
        },
        async draftTicket(): Promise<never> {
          throw new Error("not used");
        },
      },
      coder: new MockCoderAgent(),
      reviewer: new MockReviewerAgent(),
      showcase: new MockShowcaseAgent(),
    });

    await decomposeEpic(PROJECT, epic!.id);

    expect(seen.instructions).toEqual([]);
    expect(seen.existing).toBeUndefined();
  });
});
