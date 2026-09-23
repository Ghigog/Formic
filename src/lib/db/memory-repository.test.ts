import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory-repository";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("projects on the in-memory store", () => {
  it("creates a project for a repository once, whatever the casing", async () => {
    const repo = new MemoryRepository();
    const a = await repo.ensureProject({ ownerId: "u1", repoFullName: "acme/widgets", baseBranch: "main" });
    const b = await repo.ensureProject({ ownerId: "u1", repoFullName: "Acme/Widgets", baseBranch: "main" });
    expect(b.id).toBe(a.id);
    // Plus the unowned demo board.
    expect(await repo.listProjects({ ownerId: "u1", includeUnowned: true })).toHaveLength(2);
  });

  it("gives two people their own board for the same repository", async () => {
    const repo = new MemoryRepository();
    const mine = await repo.ensureProject({ ownerId: "u1", repoFullName: "acme/widgets", baseBranch: "main" });
    const theirs = await repo.ensureProject({ ownerId: "u2", repoFullName: "acme/widgets", baseBranch: "main" });
    expect(theirs.id).not.toBe(mine.id);
    expect(await repo.listProjects({ ownerId: "u1", includeUnowned: false })).toEqual([mine]);
    expect((await repo.projectsForRepo("ACME/widgets")).map((p) => p.id)).toEqual([mine.id, theirs.id]);
  });

  it("hands unowned boards and presets to whoever adopts them", async () => {
    const repo = new MemoryRepository();
    const demo = await repo.defaultProject();
    await repo.savePreset({ name: "old", model: "claude-opus-5", prompt: "p" });
    await repo.adoptUnowned("u1");
    expect((await repo.projectById(demo.id))?.ownerId).toBe("u1");
    expect(await repo.listPresets({ ownerId: "u1", includeUnowned: false })).toHaveLength(1);
    expect(await repo.listPresets({ ownerId: "u2", includeUnowned: true })).toHaveLength(0);
  });

  it("keeps each project's cards and events to itself", async () => {
    const repo = new MemoryRepository();
    const home = await repo.defaultProject();
    const other = await repo.ensureProject({ ownerId: "u1", repoFullName: "acme/widgets", baseBranch: "main" });

    const epic = await repo.createEpic({
      projectId: other.id,
      title: "Elsewhere",
      rawRequest: "Elsewhere",
      position: 1,
    });
    const [ticket] = await repo.createTickets([
      {
        epicId: epic.id,
        key: "W-1",
        title: "t",
        description: "t",
        acceptanceCriteria: [],
        fileScope: ["src"],
        size: "S",
        position: 2,
        dependsOnKeys: [],
      },
    ]);

    expect((await repo.boardCards(other.id)).map((c) => c.id)).toEqual([epic.id, ticket!.id]);
    expect(await repo.boardCards(home.id)).toEqual([]);
    expect(await repo.projectOfCard(ticket!.id)).toBe(other.id);
    expect((await repo.ticketDetail(ticket!.id))?.projectId).toBe(other.id);

    await repo.appendEvent(other.id, "card.created", {});
    expect(await repo.eventsAfter(home.id, 0)).toEqual([]);
    expect(await repo.latestEventSeq(home.id)).toBe(0);
    expect(await repo.eventsAfter(other.id, 0)).toHaveLength(1);
  });
});
