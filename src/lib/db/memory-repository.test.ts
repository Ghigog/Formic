import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory-repository";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("people on the in-memory store", () => {
  it("starts with no terms accepted, and records a version once it is", async () => {
    const repo = new MemoryRepository();
    const user = await repo.upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
    expect(user.termsAcceptedVersion).toBeNull();

    const accepted = await repo.acceptTerms(user.id, "2026-09-24");
    expect(accepted.termsAcceptedVersion).toBe("2026-09-24");
    expect((await repo.userById(user.id))?.termsAcceptedVersion).toBe("2026-09-24");
  });
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

describe("Epic spend on the in-memory store", () => {
  it("sums a run's spend as it accrues, before it finishes", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({ projectId: project.id, title: "e", rawRequest: "e", position: 1 });

    await repo.startRun({ id: "r1", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: null });
    await repo.recordRunSpend("r1", 150);

    expect(await repo.epicSpentCents(epic.id)).toBe(150);
  });

  it("does not forget a run's spend once it has finished", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({ projectId: project.id, title: "e", rawRequest: "e", position: 1 });

    await repo.startRun({ id: "r1", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: null });
    await repo.recordRunSpend("r1", 900);
    await repo.finishRun("r1", { status: "succeeded", error: null, tokensIn: 0, tokensOut: 0, costCents: 900 });

    // A second run starts once the first is long done; the Epic's total
    // still has to include what the finished run spent.
    await repo.startRun({ id: "r2", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: null });
    await repo.recordRunSpend("r2", 300);

    expect(await repo.epicSpentCents(epic.id)).toBe(1200);
  });

  it("keeps one Epic's spend out of another's sum", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const a = await repo.createEpic({ projectId: project.id, title: "a", rawRequest: "a", position: 1 });
    const b = await repo.createEpic({ projectId: project.id, title: "b", rawRequest: "b", position: 2 });

    await repo.startRun({ id: "ra", role: "coder", epicId: a.id, ticketId: null, model: null, sandboxId: null });
    await repo.recordRunSpend("ra", 500);
    await repo.startRun({ id: "rb", role: "coder", epicId: b.id, ticketId: null, model: null, sandboxId: null });
    await repo.recordRunSpend("rb", 700);

    expect(await repo.epicSpentCents(a.id)).toBe(500);
    expect(await repo.epicSpentCents(b.id)).toBe(700);
  });
});

describe("the stop flag on the in-memory store", () => {
  it("cancels every live run under a project, and leaves a finished run alone", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const elsewhere = await repo.ensureProject({ ownerId: "u1", repoFullName: "acme/elsewhere", baseBranch: "main" });
    const epic = await repo.createEpic({ projectId: project.id, title: "e", rawRequest: "e", position: 1 });
    const away = await repo.createEpic({ projectId: elsewhere.id, title: "away", rawRequest: "away", position: 1 });

    await repo.startRun({ id: "live", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: "sbx-1" });
    await repo.startRun({ id: "done", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: "sbx-2" });
    await repo.finishRun("done", { status: "succeeded", error: null, tokensIn: 0, tokensOut: 0, costCents: 0 });
    await repo.startRun({ id: "far", role: "coder", epicId: away.id, ticketId: null, model: null, sandboxId: "sbx-3" });

    const cancelled = await repo.cancelRuns({ projectId: project.id }, "Stopped by a human.");

    expect(cancelled).toEqual([{ id: "live", sandboxId: "sbx-1" }]);
    expect(await repo.runCancelReason("live")).toBe("Stopped by a human.");
    expect(await repo.runCancelReason("done")).toBeNull();
    expect(await repo.runCancelReason("far")).toBeNull();
  });

  it("cancels a single run by id, leaving its Epic's other runs live", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({ projectId: project.id, title: "e", rawRequest: "e", position: 1 });

    await repo.startRun({ id: "r1", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: null });
    await repo.startRun({ id: "r2", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: null });

    const cancelled = await repo.cancelRuns({ runId: "r1" }, "Run budget: over.");

    expect(cancelled).toEqual([{ id: "r1", sandboxId: null }]);
    expect(await repo.runCancelReason("r1")).toBe("Run budget: over.");
    expect(await repo.runCancelReason("r2")).toBeNull();
  });

  it("cancels every live run under an Epic, whichever instance started them", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({ projectId: project.id, title: "e", rawRequest: "e", position: 1 });
    const other = await repo.createEpic({ projectId: project.id, title: "o", rawRequest: "o", position: 2 });

    await repo.startRun({ id: "r1", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: null });
    await repo.startRun({ id: "r2", role: "reviewer", epicId: epic.id, ticketId: null, model: null, sandboxId: null });
    await repo.startRun({ id: "r3", role: "coder", epicId: other.id, ticketId: null, model: null, sandboxId: null });

    const cancelled = await repo.cancelRuns({ epicId: epic.id }, "Epic budget: over.");

    expect(cancelled.map((c) => c.id).sort()).toEqual(["r1", "r2"]);
    expect(await repo.runCancelReason("r3")).toBeNull();
  });

  it("does not cancel a run twice, or report a reason for one that was never stopped", async () => {
    const repo = new MemoryRepository();
    const project = await repo.defaultProject();
    const epic = await repo.createEpic({ projectId: project.id, title: "e", rawRequest: "e", position: 1 });
    await repo.startRun({ id: "r1", role: "coder", epicId: epic.id, ticketId: null, model: null, sandboxId: null });

    expect(await repo.runCancelReason("r1")).toBeNull();
    await repo.cancelRuns({ runId: "r1" }, "first");
    expect(await repo.cancelRuns({ runId: "r1" }, "second")).toEqual([]);
    expect(await repo.runCancelReason("r1")).toBe("first");
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
