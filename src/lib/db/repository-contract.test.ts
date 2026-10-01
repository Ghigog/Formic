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

    describe("token window", () => {
      it("stores the renewal day with its timezone, and the reset time", async () => {
        const user = await repo.upsertUser({ githubId: Math.floor(Math.random() * 2 ** 31), login: `u${randomUUID()}`, name: null, avatarUrl: null });
        expect([user.tokenRenewalDay, user.tokenWindowTimezone, user.tokenResetAt]).toEqual([null, null, null]);

        const renewed = await repo.updateTokenRenewal(user.id, { tokenRenewalDay: 5, tokenWindowTimezone: "Europe/Paris" });
        expect([renewed.tokenRenewalDay, renewed.tokenWindowTimezone]).toEqual([5, "Europe/Paris"]);

        const at = new Date("2026-09-12T08:00:00Z");
        const reset = await repo.stampTokenReset(user.id, at);
        expect(reset.tokenResetAt).toEqual(at);
        expect(reset.tokenRenewalDay).toBe(5);
      });
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

      it("updates a ticket's story points", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const [t] = await repo.createTickets([ticket(epic.id, "C-1", { storyPoints: 3 })]);

        await repo.updateTicket(t!.id, { storyPoints: 5 });

        expect((await repo.ticketDetail(t!.id))!.storyPoints).toBe(5);
      });

      it("keeps the work type of an Epic and a ticket", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1, workType: "bug" });
        const plain = await repo.createEpic({ projectId: p.id, title: "P", rawRequest: "P", position: 2 });
        const [t, u] = await repo.createTickets([
          ticket(epic.id, "W-1", { workType: "spike" }),
          ticket(epic.id, "W-2", { position: 2 }),
        ]);
        expect([epic.workType, plain.workType ?? null, t!.workType, u!.workType ?? null]).toEqual(["bug", null, "spike", null]);
        const cards = await repo.boardCards(p.id);
        const typeOf = (id: string) => cards.find((c) => c.id === id)?.workType ?? null;
        expect([typeOf(epic.id), typeOf(plain.id), typeOf(t!.id), typeOf(u!.id)]).toEqual(["bug", null, "spike", null]);
      });

      it("sets and clears a ticket's work type", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const [t] = await repo.createTickets([ticket(epic.id, "C-1")]);
        const typeOf = async () => (await repo.boardCards(p.id)).find((c) => c.id === t!.id)?.workType ?? null;

        await repo.updateTicket(t!.id, { workType: "spike" });
        expect(await typeOf()).toBe("spike");

        await repo.updateTicket(t!.id, { workType: null });
        expect(await typeOf()).toBeNull();
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

      it("sums an agent's tokens from its runs and its chat answers, and only its own", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const mine = `preset-${randomUUID()}`;
        const theirs = `preset-${randomUUID()}`;
        const run = (id: string, presetId: string) => ({
          id,
          role: "product" as const,
          epicId: epic.id,
          ticketId: null,
          model: null,
          presetId,
          sandboxId: null,
        });

        const [one, two, other] = [randomUUID(), randomUUID(), randomUUID()];
        await repo.startRun(run(one, mine));
        await repo.finishRun(one, { status: "succeeded", error: null, tokensIn: 1_200, tokensOut: 300, costCents: 0 });
        await repo.startRun(run(two, mine));
        await repo.finishRun(two, { status: "succeeded", error: null, tokensIn: 800, tokensOut: 200, costCents: 0 });
        // Another agent's run, which is counted to that agent and not to this one.
        await repo.startRun(run(other, theirs));
        await repo.finishRun(other, { status: "succeeded", error: null, tokensIn: 5_000, tokensOut: 5_000, costCents: 0 });

        // An answer is not a run, so its tokens are on the message instead.
        const answer = await repo.addCardChatMessage({
          projectId: p.id,
          cardKind: "epic",
          cardId: epic.id,
          role: "assistant",
          content: "because",
        });
        await repo.updateCardChatMessage(answer.id, {
          tokensIn: 400,
          tokensOut: 100,
          agentPresetId: mine,
        });

        expect(await repo.agentTokensByPreset()).toEqual({
          [mine]: { tokensIn: 2_400, tokensOut: 600 },
          [theirs]: { tokensIn: 5_000, tokensOut: 5_000 },
        });
        // A cutoff after the work leaves nothing in the window: what a plan
        // that resets monthly would count itself from.
        const cutoff = new Date(Date.now() + 60_000);
        expect(await repo.agentTokensByPreset(cutoff)).toEqual({});
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

      it("keeps auto-merge off until switched on, per project", async () => {
        const p = await project();
        expect((await repo.projectById(p.id))?.autoMerge).toBe(false);
        await repo.setAutoMerge(p.id, true);
        expect((await repo.projectById(p.id))?.autoMerge).toBe(true);
        await repo.setAutoMerge(p.id, false);
        expect((await repo.projectById(p.id))?.autoMerge).toBe(false);
      });

      it("scopes a preset to the column it was made for, and keeps that column on update", async () => {
        const preset = await repo.savePreset({
          ownerId: null,
          column: "in_review",
          provider: "anthropic",
          name: `contract-${randomUUID()}`,
          model: "claude-opus-5",
          prompt: "p",
        });
        expect(preset.column).toBe("in_review");

        const updated = await repo.savePreset({
          id: preset.id,
          column: "in_progress",
          provider: "anthropic",
          name: preset.name,
          model: preset.model,
          prompt: "changed",
        });
        expect(updated.column).toBe("in_review");
      });

      it("returns a column agent's override with the board's, and drops it with the agent", async () => {
        const p = await project();
        const preset = await repo.savePreset({
          ownerId: null,
          provider: "anthropic",
          name: `contract-${randomUUID()}`,
          model: "claude-opus-5",
          prompt: "p",
        });
        expect(await repo.setColumnOverride(p.id, "in_progress", { minutes: 5, tokens: null, attempts: null })).toBe(false);

        await repo.setColumnAgent(p.id, "in_progress", preset.id);
        await repo.setColumnAgent(p.id, "in_review", preset.id);
        expect(await repo.columnOverrides(p.id)).toEqual({});
        expect(await repo.setColumnOverride(p.id, "in_progress", { minutes: 20, tokens: 90000, attempts: null })).toBe(true);
        expect(await repo.columnOverrides(p.id)).toEqual({
          in_progress: { minutes: 20, tokens: 90000, attempts: null },
        });

        await repo.setColumnAgent(p.id, "in_progress", null);
        expect(await repo.columnOverrides(p.id)).toEqual({});
      });

      it("stores a token allowance with a rolling 30 day window by default", async () => {
        const preset = await repo.savePreset({
          ownerId: null,
          provider: "anthropic",
          name: `contract-${randomUUID()}`,
          model: "claude-opus-5",
          prompt: "p",
        });
        expect(preset).toMatchObject({ tokenAllowance: null, tokenAllowanceWindowDays: 30 });
        await repo.setPresetAllowance(preset.id, { tokens: 1_000_000, windowDays: null });
        expect((await repo.presetForRun(preset.id))?.preset).toMatchObject({
          tokenAllowance: 1_000_000,
          tokenAllowanceWindowDays: 30,
        });
        await repo.setPresetAllowance(preset.id, { tokens: 500, windowDays: 7 });
        expect((await repo.presetForRun(preset.id))?.preset).toMatchObject({ tokenAllowance: 500, tokenAllowanceWindowDays: 7 });
      });

      it("leaves a preset unscoped when no column is given, so it shows in every column", async () => {
        const preset = await repo.savePreset({
          ownerId: null,
          provider: "anthropic",
          name: `contract-${randomUUID()}`,
          model: "claude-opus-5",
          prompt: "p",
        });
        expect(preset.column).toBeNull();
      });
    });

    describe("limit settings", () => {
      it("stores Off explicitly, leaves an unset axis null, and returns a stored one", async () => {
        const user = await repo.upsertUser({ githubId: Math.floor(Math.random() * 2e9), login: "c", name: null, avatarUrl: null });
        expect(user.tokenLimit ?? null).toBeNull();
        expect(user.attemptLimit ?? null).toBeNull();

        const off = await repo.updateLimits(user.id, { tokenLimit: { mode: "OFF" } });
        expect(off.tokenLimit).toEqual({ mode: "OFF" });
        expect(off.attemptLimit ?? null).toBeNull();

        const both = await repo.updateLimits(user.id, { attemptLimit: { mode: "FLAT", flat: 3 } });
        expect(both.tokenLimit).toEqual({ mode: "OFF" });
        expect((await repo.userById(user.id))?.attemptLimit).toEqual({ mode: "FLAT", flat: 3 });

        expect((await repo.updateLimits(user.id, { tokenLimit: null })).tokenLimit ?? null).toBeNull();
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

      it("keeps what an answer spent on the message it landed on", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const base = { projectId: p.id, cardKind: "epic" as const, cardId: epic.id };

        const answer = await repo.addCardChatMessage({ ...base, role: "assistant", content: "because" });
        // A new message has spent nothing yet: the answer writes that in when it lands.
        expect(answer).toMatchObject({ tokensIn: 0, tokensOut: 0, costCents: 0 });

        await repo.updateCardChatMessage(answer.id, { tokensIn: 1_200, tokensOut: 340, costCents: 7 });
        expect(await repo.cardChatMessage(answer.id)).toMatchObject({
          tokensIn: 1_200,
          tokensOut: 340,
          costCents: 7,
        });
      });

      it("lists an answer nothing is behind, once it is older than any function could write it", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const base = { projectId: p.id, cardKind: "epic" as const, cardId: epic.id };

        const orphan = await repo.addCardChatMessage({ ...base, role: "assistant", content: "", status: "pending" });
        const inActions = await repo.addCardChatMessage({ ...base, role: "assistant", content: "", status: "pending" });
        await repo.updateCardChatMessage(inActions.id, { runnerJob: "job-9" });

        // Past any function's lifetime: the one with no job is what is left of
        // an answer whose worker died. A CLI agent's has a job behind it.
        expect((await repo.orphanedCardChats(p.id, new Date(Date.now() + 60_000))).map((m) => m.id)).toEqual([
          orphan.id,
        ]);
        // A cutoff before it was written: it may be being written right now.
        expect(await repo.orphanedCardChats(p.id, new Date(Date.now() - 60_000))).toEqual([]);
      });

      it("lists a pending assistant answer with no job, once older than the cut-off", async () => {
        const p = await project();
        const base = { projectId: p.id, role: "assistant" as const, content: "", status: "pending" as const };
        const orphan = await repo.addAssistantMessage(base);
        const inActions = await repo.addAssistantMessage(base);
        await repo.updateAssistantMessage(inActions.id, { runnerJob: "job-9" });

        expect((await repo.orphanedAssistantAnswers(p.id, new Date(Date.now() + 60_000))).map((m) => m.id)).toEqual([
          orphan.id,
        ]);
        expect(await repo.orphanedAssistantAnswers(p.id, new Date(Date.now() - 60_000))).toEqual([]);
      });
    });

    describe("audits", () => {
      const report = { likes: [{ text: "Good", ref: "a.ts" }], dislikes: [], wrong: [], missing: [] };

      it("journals a run, then keeps only the newest report per sentinel", async () => {
        const p = await project();
        const first = await repo.startAudit(p.id, "secops");
        await repo.logAudit(first.id, "Listing files");
        await repo.logAudit(first.id, "Reading 3 files");
        expect((await repo.auditsFor(p.id))[0]).toMatchObject({ status: "running", log: ["Listing files", "Reading 3 files"] });
        await repo.finishAudit(first.id, { status: "done", stars: 3, quote: "q", summary: "s", report, files: ["a.ts"], model: "m" });

        const second = await repo.startAudit(p.id, "secops");
        await repo.finishAudit(second.id, { status: "done", stars: 5, quote: "q2", summary: "s2", report, files: [], model: "m" });
        const audits = await repo.auditsFor(p.id);
        expect(audits.map((a) => [a.status, a.stars])).toEqual([["done", 5]]);
        expect(audits[0]!.report).toEqual(report);
      });

      it("keeps the last report when a newer run fails", async () => {
        const p = await project();
        const done = await repo.startAudit(p.id, "qa");
        await repo.finishAudit(done.id, { status: "done", stars: 4, quote: "q", summary: "s", report, files: [] });
        for (const error of ["first", "second"]) {
          const failed = await repo.startAudit(p.id, "qa");
          await repo.finishAudit(failed.id, { status: "failed", error });
        }
        const other = await repo.startAudit(p.id, "tester");
        const audits = await repo.auditsFor(p.id);
        expect(audits.map((a) => [a.sentinel, a.status, a.stars ?? a.error])).toEqual([
          ["qa", "done", 4],
          ["qa", "failed", "second"],
          ["tester", "running", null],
        ]);
        expect(other.status).toBe("running");
      });
    });

    describe("queens", () => {
      it("keeps one Queen per card, marks it, and counts a cleared one as spent", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        const [t] = await repo.createTickets([ticket(epic.id, "Q-1")]);

        expect(await repo.placeQueen(p.id, t!.id, "ticket")).toMatchObject({ cardId: t!.id, kind: "ticket" });
        expect(await repo.placeQueen(p.id, t!.id, "ticket")).toBeNull();
        expect((await repo.listQueens(p.id)).map((q) => q.cardId)).toEqual([t!.id]);
        expect((await repo.boardCards(p.id)).find((c) => c.id === t!.id)!.queen).toBe(true);

        expect(await repo.clearQueen(t!.id)).toBe(true);
        expect(await repo.clearQueen(t!.id)).toBe(false);
        expect(await repo.listQueens(p.id)).toEqual([]);
        expect(await repo.queensSpent(p.id)).toBe(1);
      });

      it("drops a Queen with its card", async () => {
        const p = await project();
        const epic = await repo.createEpic({ projectId: p.id, title: "E", rawRequest: "E", position: 1 });
        await repo.placeQueen(p.id, epic.id, "epic");

        await repo.deleteEpic(epic.id);

        expect(await repo.listQueens(p.id)).toEqual([]);
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
