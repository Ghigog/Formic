import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRecord } from "@/lib/db/repository";

const launched = vi.hoisted(() => [] as string[]);
const published = vi.hoisted(() => [] as Array<{ type: string }>);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agents/pipeline", () => ({
  launch: (_work: unknown, label: string) => launched.push(label),
  decomposeEpic: vi.fn(),
  runProductAgent: vi.fn(),
  runArchitectDraftTicket: vi.fn(),
  repoTree: vi.fn().mockResolvedValue([]),
  applyPrd: vi.fn(),
  startRun: vi.fn(() => ({})),
  applyShowcase: vi.fn(),
}));
vi.mock("@/lib/coder/pipeline", () => ({ runCoderAgent: vi.fn(), stallTicket: vi.fn(), taskFor: vi.fn() }));
vi.mock("@/lib/review/pipeline", () => ({ mergeByPerson: vi.fn(async () => "Red CI does not merge.") }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async (_project: string, event: { type: string }) => void published.push(event)) }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const { commentCard, createBacklogCard, createEpic, moveCard, updateCard } = await import("./tools");
const { repository } = await import("@/lib/db");

let n = 1;
let me: UserRecord;
let board: string;
const rw = () => ({ user: me, readOnly: false });
const ro = () => ({ user: me, readOnly: true });

async function ticketOnBoard() {
  const repo = repository();
  const made = await createEpic(rw(), {
    board,
    title: "E",
    rawRequest: "req",
    tickets: [{ key: "a", title: "A", description: "d", acceptanceCriteria: ["c"] }],
  });
  if (!made.ok) throw new Error(made.error);
  const ticket = made.value.tickets[0]!;
  await repo.move({ cardId: ticket.id, kind: "ticket", status: "ready", stalledIn: null, position: 1 });
  published.length = 0;
  return ticket.id;
}

beforeEach(async () => {
  launched.length = 0;
  published.length = 0;
  globalThis.__formicMemoryStore = undefined;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL;
  const repo = repository();
  me = await repo.upsertUser({ githubId: n++, login: `w${n}`, name: null, avatarUrl: null });
  board = (await repo.ensureProject({ ownerId: me.id, repoFullName: null, name: "mine", baseBranch: "main" })).id;
});

const COLUMNS = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
const agentsOff = async () => {
  for (const column of COLUMNS) await repository().setColumnAgent(board, column, null);
};

describe("write tools", () => {
  it("creates a backlog card and starts the Product Agent", async () => {
    const result = await createBacklogCard(rw(), { board, rawRequest: "Add dark mode" });
    expect(result.ok && result.value.title).toBe("Add dark mode");
    expect(published.map((e) => e.type)).toContain("card.created");
    expect(launched).toHaveLength(1);
  });

  it("creates an Epic with its tickets and their dependency", async () => {
    const result = await createEpic(rw(), {
      board,
      title: "Epic",
      rawRequest: "req",
      tickets: [
        { key: "a", title: "A", description: "d", acceptanceCriteria: ["c"] },
        { key: "b", title: "B", description: "d", acceptanceCriteria: ["c"], dependsOn: ["a"] },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    const cards = await repository().boardCards(board);
    const ids = cards.map((c) => c.id);
    expect(ids).toContain(result.value.id);
    for (const t of result.value.tickets) expect(ids).toContain(t.id);
    const [a, b] = result.value.tickets;
    expect(cards.find((c) => c.id === b!.id)!.dependsOn).toEqual([a!.id]);
    expect(published.map((e) => e.type)).toContain("card.created");
  });

  it("refuses a dependency that is not among the tickets", async () => {
    const result = await createEpic(rw(), {
      board,
      title: "Epic",
      rawRequest: "req",
      tickets: [{ key: "a", title: "A", description: "d", acceptanceCriteria: [], dependsOn: ["x"] }],
    });
    expect(result.ok).toBe(false);
    expect(await repository().boardCards(board)).toEqual([]);
  });

  it("moves a ticket through In Progress to Done on an agents-off board with no run and card.status events", async () => {
    const id = await ticketOnBoard();
    await agentsOff();
    expect(await moveCard(rw(), { board, card: id, to: "in_progress" })).toMatchObject({ ok: true, value: { status: "running", runId: null } });
    expect(await moveCard(rw(), { board, card: id, to: "done" })).toMatchObject({ ok: true });
    expect(launched).toEqual([]);
    expect(published.filter((e) => e.type === "card.status").length).toBeGreaterThanOrEqual(2);
  });

  it("starts the same run as a UI move on an agents-on board", async () => {
    const id = await ticketOnBoard();
    const repo = repository();
    const preset = await repo.savePreset({ name: "Coder", provider: "claude-code", model: "", prompt: "", apiKeyCipher: null });
    await repo.setColumnAgent(board, "in_progress", preset.id);
    expect(await moveCard(rw(), { board, card: id, to: "in_progress" })).toMatchObject({ ok: true, value: { status: "running" } });
    expect(launched).toHaveLength(1);
  });

  it("returns the board's reason when it refuses a move", async () => {
    const id = await ticketOnBoard();
    const repo = repository();
    const preset = await repo.savePreset({ name: "Coder", provider: "claude-code", model: "", prompt: "", apiKeyCipher: null });
    await repo.setColumnAgent(board, "done", preset.id);
    // A pull request that will not merge: the move is refused with the reason.
    globalThis.__formicMemoryStore!.cards.get(id)!.prNumber = 7;
    const result = await moveCard(rw(), { board, card: id, to: "done" });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/Red CI/);
  });

  it("updates a ticket's fields", async () => {
    const id = await ticketOnBoard();
    expect(await updateCard(rw(), { board, card: id, edit: { title: "New", acceptanceCriteria: ["x"] } })).toMatchObject({ ok: true });
    const t = await repository().ticketDetail(id);
    expect(t).toMatchObject({ title: "New", acceptanceCriteria: ["x"] });
    expect(published.map((e) => e.type)).toContain("card.status");
  });

  it("stores a person's message in the chat and no agent answers", async () => {
    const id = await ticketOnBoard();
    expect(await commentCard(rw(), { board, card: id, text: "hello" })).toMatchObject({ ok: true });
    const messages = await repository().cardChatMessages(id);
    expect(messages).toMatchObject([{ role: "user", content: "hello", status: "done" }]);
    expect(launched).toEqual([]);
  });
});

describe("a read-only token", () => {
  it("is refused by every write tool and nothing changes", async () => {
    const id = await ticketOnBoard();
    const repo = repository();
    const before = JSON.stringify(await repo.boardCards(board));
    const results = [
      await createBacklogCard(ro(), { board, rawRequest: "Add dark mode" }),
      await createEpic(ro(), { board, title: "E", rawRequest: "r", tickets: [{ key: "a", title: "A", description: "", acceptanceCriteria: [] }] }),
      await moveCard(ro(), { board, card: id, to: "done" }),
      await updateCard(ro(), { board, card: id, edit: { title: "New" } }),
      await commentCard(ro(), { board, card: id, text: "hi" }),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    expect(JSON.stringify(await repo.boardCards(board))).toBe(before);
    expect(await repo.cardChatMessages(id)).toEqual([]);
    expect(launched).toEqual([]);
    expect(published).toEqual([]);
  });
});
