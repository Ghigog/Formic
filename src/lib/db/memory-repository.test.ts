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
    await repo.savePreset({ name: "old", provider: "anthropic", model: "claude-opus-5", prompt: "p" });
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

describe("merges on the in-memory store", () => {
  async function twoTickets(repo: MemoryRepository, projectId: string) {
    const epic = await repo.createEpic({ projectId, title: "E", rawRequest: "E", position: 1 });
    return repo.createTickets(
      ["A", "B"].map((k, i) => ({
        epicId: epic.id,
        key: `${k}-1`,
        title: k,
        description: k,
        acceptanceCriteria: [],
        fileScope: [`src/${k}`],
        size: "S" as const,
        storyPoints: 4,
        position: i,
        dependsOnKeys: [],
      })),
    );
  }

  it("scores each merge against the project's heat, once", async () => {
    const repo = new MemoryRepository();
    const project = await repo.ensureProject({ ownerId: "u1", repoFullName: "acme/heat", baseBranch: "main" });
    const [a, b] = await twoTickets(repo, project.id);

    await repo.updateTicket(a!.id, { status: "merged" });
    await repo.updateTicket(b!.id, { status: "merged" });
    const byId = new Map((await repo.boardCards(project.id)).map((c) => [c.id, c]));

    expect(byId.get(a!.id)).toMatchObject({ mergePoints: 4, mergeMultiplier: 1 });
    // One merge in the window before it: one heat stack.
    expect(byId.get(b!.id)).toMatchObject({ mergePoints: 6, mergeMultiplier: 1.5 });
    const stamped = byId.get(a!.id)!.mergedAt;
    expect(stamped).toBeTruthy();

    await repo.updateTicket(a!.id, { status: "merged" });
    expect((await repo.cardById(a!.id))!.mergedAt).toBe(stamped);
  });

  it("does not heat one project with another's merges", async () => {
    const repo = new MemoryRepository();
    const one = await repo.ensureProject({ ownerId: "u1", repoFullName: "acme/one", baseBranch: "main" });
    const two = await repo.ensureProject({ ownerId: "u1", repoFullName: "acme/two", baseBranch: "main" });
    const [a] = await twoTickets(repo, one.id);
    const [b] = await twoTickets(repo, two.id);

    await repo.updateTicket(a!.id, { status: "merged" });
    await repo.updateTicket(b!.id, { status: "merged" });
    expect((await repo.cardById(b!.id))!.mergeMultiplier).toBe(1);
  });
});

describe("Epic numbers on the in-memory store", () => {
  it("never gives a deleted Epic's number to a new one", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const make = (title: string) =>
      repo.createEpic({ projectId: project.id, title, rawRequest: title, position: 1 });
    const one = await make("one");
    const two = await make("two");
    await repo.deleteEpic(two.id);
    const three = await make("three");

    expect([one.key, three.key]).toEqual(["EPIC-1", "EPIC-3"]);
    expect(await repo.cardById(two.id)).toBeNull();
  });
});

describe("standalone Epics on the in-memory store", () => {
  it("hides a standalone Epic from boardCards() while its detached ticket still renders", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({
      projectId: project.id,
      title: "A lone request",
      rawRequest: "A lone request",
      position: 1,
    });
    const [ticket] = await repo.createTickets([
      {
        epicId: epic.id,
        key: "W-1",
        title: "Do the thing",
        description: "Do the thing",
        acceptanceCriteria: [],
        fileScope: ["src"],
        size: "S",
        position: 2,
        dependsOnKeys: [],
      },
    ]);
    await repo.setStandalone(epic.id, true);
    await repo.move({
      cardId: ticket!.id,
      kind: "ticket",
      status: ticket!.status,
      stalledIn: null,
      position: ticket!.position,
      detached: true,
    });

    const cards = await repo.boardCards(project.id);
    expect(cards.find((c) => c.id === epic.id)).toBeUndefined();
    const ticketCard = cards.find((c) => c.id === ticket!.id);
    expect(ticketCard).toBeTruthy();
    expect(ticketCard!.detached).toBe(true);
  });
});

describe("attachments on the in-memory store", () => {
  it("moves attachments from a requestId to a real card with claimAttachments", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const a = await repo.createAttachment({
      projectId: project.id,
      requestId: "req-1",
      filename: "a.png",
      mimeType: "image/png",
      kind: "image",
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });
    const b = await repo.createAttachment({
      projectId: project.id,
      requestId: "req-1",
      filename: "b.txt",
      mimeType: "text/plain",
      kind: "file",
      size: 4,
      bytes: new Uint8Array([4, 5, 6, 7]),
    });

    await repo.claimAttachments("req-1", { ticketId: "ticket-1" });

    expect(await repo.attachmentsFor({ requestId: "req-1" })).toEqual([]);
    const claimed = await repo.attachmentsFor({ ticketId: "ticket-1" });
    expect(claimed.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("round-trips the exact bytes and mime type through attachmentContent", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const attachment = await repo.createAttachment({
      projectId: project.id,
      requestId: "req-2",
      filename: "c.bin",
      mimeType: "application/octet-stream",
      kind: "file",
      size: bytes.length,
      bytes,
    });

    const content = await repo.attachmentContent(attachment.id);
    expect(content?.mimeType).toBe("application/octet-stream");
    expect(Array.from(content!.bytes)).toEqual(Array.from(bytes));
    expect(await repo.attachmentContent("nope")).toBeNull();
  });
});

describe("rerouting on the in-memory store", () => {
  it("sets exactly rerouteFrom and rerouteReason, leaving everything else as it was", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({
      projectId: project.id,
      title: "Reroute me",
      rawRequest: "Reroute me",
      position: 1,
    });
    const before = await repo.cardById(epic.id);

    await repo.setReroute(epic.id, "epic", { from: "todo", reason: "belongs in the backlog" });

    const after = await repo.cardById(epic.id);
    expect(after).toMatchObject({ ...before, rerouteFrom: "todo", rerouteReason: "belongs in the backlog" });

    const viaBoard = (await repo.boardCards(project.id)).find((c) => c.id === epic.id);
    expect(viaBoard).toMatchObject({ rerouteFrom: "todo", rerouteReason: "belongs in the backlog" });

    await repo.setReroute(epic.id, "epic", null);
    expect(await repo.cardById(epic.id)).toMatchObject({ ...before, rerouteFrom: null, rerouteReason: null });
  });

  it("flips only standalone, leaving the rest of the Epic card untouched", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({
      projectId: project.id,
      title: "Flip me",
      rawRequest: "Flip me",
      position: 1,
    });
    const before = await repo.cardById(epic.id);

    await repo.setStandalone(epic.id, true);

    expect(await repo.cardById(epic.id)).toMatchObject({ ...before, standalone: true });
  });
});

describe("how long an agent has been at a card", () => {
  it("dates an Epic's work from when its job was sent, and clears it after", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({ projectId: project.id, title: "e", rawRequest: "e", position: 1 });
    const read = async () => (await repo.boardCards(project.id)).find((c) => c.id === epic.id)!;

    expect((await read()).workingSince ?? null).toBeNull();

    await repo.setEpicRunnerJob(epic.id, "job-1");
    const working = await read();
    expect(working.agentRole).toBe("product");
    expect(Date.parse(working.workingSince!)).toBeLessThanOrEqual(Date.now());

    await repo.setEpicRunnerJob(epic.id, null);
    expect(await read()).toMatchObject({ agentRole: null, workingSince: null });
  });
});
