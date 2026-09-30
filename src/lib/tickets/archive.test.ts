import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRepository } from "@/lib/db/memory-repository";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

const ticketInput = (epicId: string, key: string, position: number) => ({
  epicId,
  key,
  title: key,
  description: key,
  acceptanceCriteria: [],
  fileScope: ["src"],
  size: "S" as const,
  position,
  dependsOnKeys: [],
});

/** The board query the archive has to stay out of, and the archive list. */
describe("the archive on the in-memory store", () => {
  it("takes a ticket off boardCards() and lists it in archivedTickets()", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({
      projectId: project.id,
      title: "Epic",
      rawRequest: "Epic",
      position: 1,
    });
    const [a, b] = await repo.createTickets([
      ticketInput(epic.id, "W-1", 2),
      ticketInput(epic.id, "W-2", 3),
    ]);

    await repo.updateTicket(a!.id, { archived: true });

    // Off the active board, in the archive, and only archived ones there.
    expect((await repo.boardCards(project.id)).map((c) => c.id)).toEqual([epic.id, b!.id]);
    expect((await repo.archivedTickets(project.id)).map((c) => c.id)).toEqual([a!.id]);
    expect((await repo.archivedTickets(project.id)).every((c) => c.archived === true)).toBe(true);
    expect(await repo.cardById(a!.id)).toMatchObject({ archived: true });
  });

  it("is idempotent: archiving again changes nothing and still succeeds", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({
      projectId: project.id,
      title: "Epic",
      rawRequest: "Epic",
      position: 1,
    });
    const [a] = await repo.createTickets([ticketInput(epic.id, "W-1", 2)]);

    await repo.updateTicket(a!.id, { archived: true });
    await repo.updateTicket(a!.id, { archived: true });

    expect((await repo.boardCards(project.id)).map((c) => c.id)).toEqual([epic.id]);
    expect((await repo.archivedTickets(project.id)).map((c) => c.id)).toEqual([a!.id]);
    expect(await repo.cardById(a!.id)).toMatchObject({ archived: true });
  });

  it("keeps each project's archive to itself", async () => {
    const repo = new MemoryRepository();
    const home = await repo.defaultProject();
    const other = await repo.ensureProject({
      ownerId: "u1",
      repoFullName: "acme/widgets",
      baseBranch: "main",
    });
    const epic = await repo.createEpic({
      projectId: other.id,
      title: "Elsewhere",
      rawRequest: "Elsewhere",
      position: 1,
    });
    const [t] = await repo.createTickets([ticketInput(epic.id, "W-1", 2)]);
    await repo.updateTicket(t!.id, { archived: true });

    expect((await repo.archivedTickets(other.id)).map((c) => c.id)).toEqual([t!.id]);
    expect(await repo.archivedTickets(home.id)).toEqual([]);
  });
});
