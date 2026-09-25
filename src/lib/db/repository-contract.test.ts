import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory-repository";
import { PrismaRepository } from "./prisma-repository";
import type { CreateTicketInput, Repository } from "./repository";

/**
 * One contract, both stores. The in-memory store is what the app runs on
 * with no database and what most tests use; Prisma is what production runs.
 * Every case here must hold for both, so a behavior one store has and the
 * other lacks fails here instead of in production.
 *
 * The Postgres half runs only when TEST_DATABASE_URL points at a database
 * with the schema pushed (CI does this). Each case works in its own
 * project, so nothing needs truncating between them.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function contract(name: string, make: () => Repository) {
  describe(`repository contract: ${name}`, () => {
    let repo: Repository;
    beforeEach(() => {
      repo = make();
    });

    const project = () =>
      repo.ensureProject({ ownerId: null, repoFullName: `contract/${randomUUID()}`, baseBranch: "main" });

    const ticket = (epicId: string, key: string, over: Partial<CreateTicketInput> = {}): CreateTicketInput => ({
      epicId,
      key,
      title: key,
      description: key,
      acceptanceCriteria: [],
      fileScope: [`src/${key}`],
      size: "S",
      position: 1,
      dependsOnKeys: [],
      ...over,
    });

    describe("projects", () => {
      it("creates a project for a repository once, whatever the casing", async () => {
        const repoName = `Contract/${randomUUID()}`;
        const a = await repo.ensureProject({ ownerId: null, repoFullName: repoName, baseBranch: "main" });
        const b = await repo.ensureProject({ ownerId: null, repoFullName: repoName.toLowerCase(), baseBranch: "main" });
        expect(b.id).toBe(a.id);
        expect(await repo.projectById(a.id)).toEqual(a);
        expect((await repo.projectsForRepo(repoName.toUpperCase())).map((p) => p.id)).toEqual([a.id]);
      });

      it("returns null for a project that does not exist", async () => {
        expect(await repo.projectById(randomUUID())).toBeNull();
      });
    });

    describe("epics and tickets", () => {
      it("creates an Epic with tickets, their dependencies, and the project they belong to", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "Do E", position: 1 });
        const [a, b] = await repo.createTickets([
          ticket(epic.id, "C-1"),
          ticket(epic.id, "C-2", { position: 2, dependsOnKeys: ["C-1"], storyPoints: 3 }),
        ]);

        expect(epic).toMatchObject({ kind: "epic", title: "E", epicId: null });
        expect(a).toMatchObject({ kind: "ticket", key: "C-1", epicId: epic.id });
        expect(b!.dependsOn).toEqual([a!.id]);
        expect(b!.storyPoints).toBe(3);
        expect(await repo.projectOfCard(b!.id)).toBe(p.id);
        expect(await repo.projectOfCard(epic.id)).toBe(p.id);
        expect((await repo.boardCards(p.id)).map((c) => c.id).sort()).toEqual([epic.id, a!.id, b!.id].sort());

        const detail = await repo.ticketDetail(b!.id);
        expect(detail).toMatchObject({ epicId: epic.id, projectId: p.id, key: "C-2", fileScope: ["src/C-2"] });
        expect((await repo.ticketsForEpic(epic.id)).map((t) => t.id).sort()).toEqual([a!.id, b!.id].sort());
        expect((await repo.epicDetail(epic.id))?.rawRequest).toBe("Do E");
      });

      it("updates a ticket and finds it by its pull request", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const [t] = await repo.createTickets([ticket(epic.id, "C-1")]);

        await repo.updateTicket(t!.id, {
          status: "review",
          prNumber: 42,
          prUrl: "https://example.test/pr/42",
          plan: [{ step: "write it", status: "done" }],
          handoff: ["rotate the key"],
          attempts: 2,
        });

        const byPr = await repo.ticketByPrNumber(p.id, 42);
        expect(byPr).toMatchObject({
          id: t!.id,
          status: "review",
          prUrl: "https://example.test/pr/42",
          attempts: 2,
          handoff: ["rotate the key"],
        });
        expect(byPr!.plan).toEqual([{ step: "write it", status: "done" }]);
        expect(await repo.ticketByPrNumber(p.id, 43)).toBeNull();
      });

      it("stores an Epic's PRD, issue, runner job and showcase", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });

        await repo.setEpicPrd(epic.id, { goals: ["ship"] }, true);
        await repo.setEpicIssue(epic.id, 7);
        await repo.setEpicRunnerJob(epic.id, "job-1", null);
        await repo.setEpicShowcase(epic.id, "# Done");

        const detail = await repo.epicDetail(epic.id);
        expect(detail).toMatchObject({
          prd: { goals: ["ship"] },
          issueNumber: 7,
          runnerJob: "job-1",
          showcase: "# Done",
        });
        expect(detail!.prdUpdatedAt).toBeInstanceOf(Date);
      });

      it("deletes tickets, and an Epic with everything under it", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const [a, b] = await repo.createTickets([
          ticket(epic.id, "C-1"),
          ticket(epic.id, "C-2", { dependsOnKeys: ["C-1"] }),
        ]);

        await repo.deleteTickets([a!.id]);
        expect(await repo.cardById(a!.id)).toBeNull();
        expect((await repo.cardById(b!.id))!.dependsOn).toEqual([]);

        await repo.deleteEpic(epic.id);
        expect(await repo.cardById(epic.id)).toBeNull();
        expect(await repo.cardById(b!.id)).toBeNull();
        expect(await repo.boardCards(p.id)).toEqual([]);
      });

      it("stalls an Epic in its column with the reason", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });

        await repo.stallEpic(epic.id, { status: "blocked", stalledIn: "backlog", stage: 2, reason: "no PRD" });

        expect(await repo.cardById(epic.id)).toMatchObject({
          status: "blocked",
          stalledIn: "backlog",
          stage: 2,
          blockedReason: "no PRD",
        });
      });
    });

    describe("board ordering and moves", () => {
      it("moves a card, and reports column positions in ascending order", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const [a, b] = await repo.createTickets([
          ticket(epic.id, "C-1", { position: 30 }),
          ticket(epic.id, "C-2", { position: 10 }),
        ]);

        for (const t of [a!, b!]) {
          await repo.move({ cardId: t.id, kind: "ticket", status: "ready", stalledIn: null, position: t.position });
        }
        expect(await repo.columnPositions(p.id, "todo")).toEqual([10, 30]);

        await repo.move({ cardId: a!.id, kind: "ticket", status: "ready", stalledIn: null, position: 5, detached: true });
        expect(await repo.cardById(a!.id)).toMatchObject({ status: "ready", position: 5, detached: true });
        expect(await repo.columnPositions(p.id, "todo")).toEqual([5, 10]);
      });

      it("records and clears where a card was misplaced", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });

        await repo.move({
          cardId: epic.id,
          kind: "epic",
          status: "draft",
          stalledIn: null,
          position: 1,
          misplaced: { in: "in_review", reason: "no PR" },
        });
        expect(await repo.cardById(epic.id)).toMatchObject({ misplacedIn: "in_review", misplacedReason: "no PR" });

        await repo.move({ cardId: epic.id, kind: "epic", status: "draft", stalledIn: null, position: 1 });
        expect(await repo.cardById(epic.id)).toMatchObject({ misplacedIn: null, misplacedReason: null });
      });

      it("rebalances a column without changing its order", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const tickets = await repo.createTickets(
          [1, 1.0000001, 1.0000002].map((position, i) => ticket(epic.id, `C-${i}`, { position })),
        );
        for (const t of tickets) {
          await repo.move({ cardId: t.id, kind: "ticket", status: "ready", stalledIn: null, position: t.position });
        }

        await repo.rebalanceColumn(p.id, "todo");

        const after = await Promise.all(tickets.map((t) => repo.cardById(t.id)));
        const positions = after.map((c) => c!.position);
        expect([...positions].sort((x, y) => x - y)).toEqual(positions);
        expect(new Set(positions).size).toBe(3);
      });
    });

    describe("attachments", () => {
      it("round-trips bytes and moves a request's attachments to its card", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const requestId = randomUUID();
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const a = await repo.createAttachment({
          projectId: p.id,
          requestId,
          filename: "a.bin",
          mimeType: "application/octet-stream",
          kind: "file",
          size: bytes.length,
          bytes,
        });

        const content = await repo.attachmentContent(a.id);
        expect(content?.mimeType).toBe("application/octet-stream");
        expect(Array.from(content!.bytes)).toEqual([1, 2, 3, 4]);

        await repo.claimAttachments(requestId, { epicId: epic.id });
        expect(await repo.attachmentsFor({ requestId })).toEqual([]);
        expect((await repo.attachmentsFor({ epicId: epic.id })).map((x) => x.id)).toEqual([a.id]);

        await repo.deleteAttachments([a.id]);
        expect(await repo.attachmentContent(a.id)).toBeNull();
      });
    });

    describe("events", () => {
      it("sequences a project's events and filters them by card", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const [t] = await repo.createTickets([ticket(epic.id, "C-1")]);

        const first = await repo.appendEvent(p.id, "agent.said", { ticketId: t!.id, text: "hi" });
        const second = await repo.appendEvent(p.id, "agent.said", { epicId: epic.id, text: "plan" });
        await repo.appendEvent(p.id, "card.moved", { ticketId: t!.id });

        expect(second).toBeGreaterThan(first);
        expect(await repo.latestEventSeq(p.id)).toBeGreaterThan(second);
        expect((await repo.eventsAfter(p.id, first)).map((e) => e.type)).toEqual(["agent.said", "card.moved"]);
        expect((await repo.ticketEvents(p.id, t!.id, ["agent.said"])).map((e) => e.payload)).toEqual([
          { ticketId: t!.id, text: "hi" },
        ]);
        expect((await repo.epicEvents(p.id, epic.id, ["agent.said"])).map((e) => e.seq)).toEqual([second]);
      });
    });

    describe("runs", () => {
      it("sums spend across live and finished runs, and cancels only live ones", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const [done, live] = [randomUUID(), randomUUID()];
        const run = (id: string) => ({ id, role: "coder" as const, epicId: epic.id, ticketId: null, model: null, sandboxId: `sbx-${id}` });

        await repo.startRun(run(done));
        await repo.recordRunSpend(done, 400);
        await repo.finishRun(done, { status: "succeeded", error: null, tokensIn: 1, tokensOut: 2, costCents: 400 });
        await repo.startRun(run(live));
        await repo.recordRunSpend(live, 250);

        expect(await repo.epicSpentCents(epic.id)).toBe(650);
        expect(await repo.cancelRuns({ epicId: epic.id }, "stop")).toEqual([{ id: live, sandboxId: `sbx-${live}` }]);
        expect(await repo.runCancelReason(live)).toBe("stop");
        expect(await repo.runCancelReason(done)).toBeNull();
      });
    });

    describe("presets and column agents", () => {
      it("saves a preset, assigns it to a column, and unassigns it on delete", async () => {
        const p = await project();
        const preset = await repo.savePreset({
          ownerId: null,
          provider: "anthropic",
          name: `contract-${randomUUID()}`,
          model: "claude-opus-5",
          prompt: "p",
          apiKeyCipher: "sealed",
          apiKeyHint: "…1234",
        });
        expect(preset).toMatchObject({ hasKey: true, keyHint: "…1234" });
        expect((await repo.presetForRun(preset.id))?.apiKeyCipher).toBe("sealed");

        await repo.setColumnAgent(p.id, "in_progress", preset.id);
        await repo.setAssistantAgent(p.id, preset.id);
        expect(await repo.columnAgents(p.id)).toEqual({ in_progress: preset.id });
        expect(await repo.assistantAgent(p.id)).toBe(preset.id);

        await repo.deletePreset(preset.id);
        expect(await repo.presetForRun(preset.id)).toBeNull();
        expect(await repo.columnAgents(p.id)).toEqual({});
      });
    });

    describe("card chat", () => {
      it("keeps a card's chat in order, and lists the answers still pending", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const base = { projectId: p.id, cardKind: "epic" as const, cardId: epic.id };

        await repo.addCardChatMessage({ ...base, role: "user", content: "why?" });
        const answer = await repo.addCardChatMessage({ ...base, role: "assistant", content: "", status: "pending" });
        await repo.updateCardChatMessage(answer.id, { runnerJob: "job-9" });

        expect((await repo.cardChatMessages(epic.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
        expect((await repo.pendingCardChatJobs(p.id)).map((m) => m.id)).toEqual([answer.id]);

        await repo.updateCardChatMessage(answer.id, { content: "because", status: "done" });
        expect(await repo.cardChatMessage(answer.id)).toMatchObject({ content: "because", status: "done" });
        expect(await repo.pendingCardChatJobs(p.id)).toEqual([]);

        await repo.clearCardChat(epic.id);
        expect(await repo.cardChatMessages(epic.id)).toEqual([]);
      });
    });

    describe("webhook deliveries", () => {
      it("claims a delivery once", async () => {
        const key = `delivery-${randomUUID()}`;
        expect(await repo.claimDelivery(key)).toBe(true);
        expect(await repo.claimDelivery(key)).toBe(false);
      });
    });
  });
}

contract("memory", () => {
  globalThis.__formicMemoryStore = undefined;
  return new MemoryRepository();
});

describe.skipIf(!TEST_DATABASE_URL)("on Postgres", () => {
  beforeAll(() => {
    // The client reads DATABASE_URL, which the test setup strips so nothing
    // else here can reach a real database by accident.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });
  afterAll(async () => {
    await globalThis.__formicPrisma?.$disconnect();
    globalThis.__formicPrisma = undefined;
    delete process.env.DATABASE_URL;
  });

  contract("postgres", () => new PrismaRepository());
});
