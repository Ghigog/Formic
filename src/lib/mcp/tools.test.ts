import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@/lib/db/repository";
import { MemoryRepository } from "@/lib/db/memory-repository";

vi.mock("server-only", () => ({}));
const repo: Repository = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));

const { listBoards, listCards, getCard, getColony } = await import("./tools");

let n = 1;
const newUser = () => repo.upsertUser({ githubId: n++, login: `u${n}`, name: null, avatarUrl: null });

async function boardWithCards(ownerId: string, name: string) {
  const project = await repo.ensureProject({ ownerId, repoFullName: null, name, baseBranch: "main" });
  const epic = await repo.createEpic({ projectId: project.id, title: "Epic", rawRequest: "req", position: 1 });
  await repo.setEpicPrd(epic.id, { summary: "S", problem: "P", scope: ["a"], successCriteria: ["c"] }, false);
  const [ticket] = await repo.createTickets([
    { epicId: epic.id, key: "T-1", title: "Ticket", description: "do it", acceptanceCriteria: ["it works"], fileScope: [], position: 1, dependsOnKeys: [] },
  ]);
  return { project, epic, ticket: ticket! };
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("read tools", () => {
  it("lists the user's boards and not other people's", async () => {
    const me = await newUser();
    const other = await newUser();
    const mine = await boardWithCards(me.id, "mine");
    const theirs = await boardWithCards(other.id, "theirs");
    const ids = (await listBoards(me)).map((b) => b.id);
    expect(ids).toContain(mine.project.id);
    expect(ids).not.toContain(theirs.project.id);
  });

  it("lists cards, optionally by column", async () => {
    const me = await newUser();
    const { project, ticket } = await boardWithCards(me.id, "mine");
    const all = await listCards(me, { board: project.id });
    expect(all.ok && all.value.map((c) => c.id)).toContain(ticket.id);
    const done = await listCards(me, { board: project.id, column: "done" });
    expect(done).toEqual({ ok: true, value: [] });
  });

  it("reports a board the user cannot see as not found", async () => {
    const me = await newUser();
    const other = await newUser();
    const { project, ticket } = await boardWithCards(other.id, "theirs");
    expect(await listCards(me, { board: project.id })).toMatchObject({ ok: false, error: "Board not found" });
    expect(await getCard(me, { board: project.id, card: ticket.id })).toMatchObject({ ok: false });
    expect(await getColony(me, { board: project.id })).toMatchObject({ ok: false });
  });

  it("returns an Epic's PRD and a ticket's acceptance criteria", async () => {
    const me = await newUser();
    const { project, epic, ticket } = await boardWithCards(me.id, "mine");
    const e = await getCard(me, { board: project.id, card: epic.id });
    expect(e.ok && e.value).toMatchObject({ kind: "epic", prd: { summary: "S" } });
    const t = await getCard(me, { board: project.id, card: ticket.id });
    expect(t.ok && t.value).toMatchObject({ kind: "ticket", acceptanceCriteria: ["it works"] });
  });

  it("does not return a card of another board through a visible one", async () => {
    const me = await newUser();
    const other = await newUser();
    const mine = await boardWithCards(me.id, "mine");
    const theirs = await boardWithCards(other.id, "theirs");
    expect(await getCard(me, { board: mine.project.id, card: theirs.ticket.id })).toMatchObject({ ok: false });
    expect(await getCard(me, { board: mine.project.id, card: theirs.epic.id })).toMatchObject({ ok: false });
  });

  it("reports level and XP within the level", async () => {
    const me = await newUser();
    const { project } = await boardWithCards(me.id, "mine");
    expect(await getColony(me, { board: project.id })).toEqual({
      ok: true,
      value: { level: 1, xp: 0, xpIntoLevel: 0, xpPerLevel: 50 },
    });
  });
});
