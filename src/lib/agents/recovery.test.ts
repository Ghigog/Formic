import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const resume = vi.fn(async () => "restarted");
vi.mock("./card-actions", () => ({ resume: (...a: unknown[]) => (resume as (...x: unknown[]) => unknown)(...a) }));
const stopTicket = vi.fn(async () => true);
const lastStepOf = vi.fn((): string | null => null);
vi.mock("@/lib/runner/runner", () => ({
  stopTicket: (...a: unknown[]) => (stopTicket as (...x: unknown[]) => unknown)(...a),
  lastStepOf: () => lastStepOf(),
}));

const { repository } = await import("@/lib/db");
const {
  CHAT_ORPHAN_AFTER_MS,
  ORPHAN_AFTER_MS,
  STUCK_AFTER_MS,
  handleStuckRuns,
  reconcileOrphanedRuns,
  recoverStaleAssistantAnswers,
  recoverStaleCardChats,
  resetChatRecovery,
  startRecoveryClock,
  stopRecoveryClock,
} = await import("./recovery");

const PROJECT = "project_default";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  resetChatRecovery();
});

describe("reconcileOrphanedRuns", () => {
  it("leaves a run that could still be live in another instance alone", async () => {
    await repository().startRun({
      id: "run_live",
      role: "product",
      epicId: null,
      ticketId: null,
      model: "mock",
      sandboxId: null,
    });

    expect(await reconcileOrphanedRuns(new Date())).toBe(0);
    expect(
      await reconcileOrphanedRuns(new Date(Date.now() + ORPHAN_AFTER_MS + 1_000)),
    ).toBe(1);
  });
});

describe("startRecoveryClock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopRecoveryClock();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fails a run left live past ORPHAN_AFTER_MS without any restart", async () => {
    startRecoveryClock();
    await vi.advanceTimersByTimeAsync(0);
    await repository().startRun({
      id: "run_dead",
      role: "product",
      epicId: null,
      ticketId: null,
      model: "mock",
      sandboxId: null,
    });

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(await repository().unfinishedRuns(new Date(Date.now() + 1_000))).toHaveLength(0);
  });

  it("only logs a warning when the repository rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(repository(), "unfinishedRuns").mockRejectedValue(new Error("db down"));

    startRecoveryClock();
    await vi.advanceTimersByTimeAsync(0);

    expect(warn).toHaveBeenCalledWith("[formic] orphan recovery skipped:", expect.any(Error));
  });

  it("starts one interval however often it is called", () => {
    startRecoveryClock();
    startRecoveryClock();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("recoverStaleCardChats", () => {
  /** A card chat answer waiting on something to write it. */
  function pendingFor(cardId: string, job: string | null = null) {
    return repository()
      .addCardChatMessage({
        projectId: PROJECT,
        cardKind: "epic",
        cardId,
        role: "assistant",
        content: "",
        status: "pending",
      })
      .then(async (message) => {
        if (job) await repository().updateCardChatMessage(message.id, { runnerJob: job });
        return message;
      });
  }

  it("fails an answer nothing is behind, so the card's chat takes questions again", async () => {
    const pending = await pendingFor("epic_1");

    // Still within any function's lifetime: it may be being written right now.
    expect(await recoverStaleCardChats(PROJECT)).toBe(0);

    const later = new Date(Date.now() + CHAT_ORPHAN_AFTER_MS + 1_000);
    expect(await recoverStaleCardChats(PROJECT, later)).toBe(1);

    expect(await repository().cardChatMessage(pending.id)).toMatchObject({
      status: "failed",
      content: "The agent stopped before it could answer. Ask it again.",
    });
  });

  it("leaves an answer a CLI agent is still writing in GitHub Actions alone", async () => {
    const pending = await pendingFor("epic_2", "job-1");

    const later = new Date(Date.now() + CHAT_ORPHAN_AFTER_MS + 1_000);
    expect(await recoverStaleCardChats(PROJECT, later)).toBe(0);
    expect((await repository().cardChatMessage(pending.id))?.status).toBe("pending");
  });

  it("walks the crew the board left on the card home", async () => {
    const pending = await pendingFor("epic_3");

    const later = new Date(Date.now() + CHAT_ORPHAN_AFTER_MS + 1_000);
    await recoverStaleCardChats(PROJECT, later);

    const events = await repository().eventsAfter(PROJECT, 0, 50);
    expect(events.filter((e) => e.type === "card.chat").map((e) => e.payload)).toContainEqual({
      type: "card.chat",
      cardId: pending.cardId,
      kind: "epic",
      state: "idle",
    });
  });
});


describe("recoverStaleAssistantAnswers", () => {
  const pending = () =>
    repository().addAssistantMessage({ projectId: PROJECT, role: "assistant", content: "", status: "pending" });
  const later = () => new Date(Date.now() + CHAT_ORPHAN_AFTER_MS + 1_000);

  it("leaves a young answer alone", async () => {
    const message = await pending();
    expect(await recoverStaleAssistantAnswers(PROJECT)).toBe(0);
    expect((await repository().assistantMessage(message.id))?.status).toBe("pending");
  });

  it("fails an old orphan and publishes it", async () => {
    const message = await pending();
    expect(await recoverStaleAssistantAnswers(PROJECT, later())).toBe(1);
    expect(await repository().assistantMessage(message.id)).toMatchObject({
      status: "failed",
      content: "The assistant stopped before it could answer. Ask it again.",
    });
    const events = await repository().eventsAfter(PROJECT, 0, 50);
    expect(events.map((e) => e.payload)).toContainEqual({ type: "assistant.failed", messageId: message.id });
  });

  it("leaves an answer with a job behind it alone", async () => {
    const message = await pending();
    await repository().updateAssistantMessage(message.id, { runnerJob: "job-1" });
    expect(await recoverStaleAssistantAnswers(PROJECT, later())).toBe(0);
    expect((await repository().assistantMessage(message.id))?.status).toBe("pending");
  });
});

describe("handleStuckRuns", () => {
  const MIN = 60 * 1000;
  const T0 = new Date("2026-01-01T12:00:00Z");

  /** A ticket with a Coder Agent run live on it, whose last commit was `minutesAgo` before T0. */
  async function runningTicket(minutesAgo: number, stuckNote: string | null = null) {
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "r", position: 1 });
    const [card] = await repo.createTickets([
      {
        epicId: epic.id,
        key: "T-1",
        title: "Do it",
        description: "d",
        acceptanceCriteria: ["done"],
        fileScope: ["src"],
        position: 1,
        dependsOnKeys: [],
      },
    ]);
    await repo.updateTicket(card!.id, {
      status: "running",
      lastCommitAt: new Date(T0.getTime() - minutesAgo * MIN),
      stuckNote,
    });
    return card!.id;
  }

  beforeEach(() => {
    resume.mockClear();
    stopTicket.mockClear();
    lastStepOf.mockReturnValue("Running the tests");
  });

  it("restarts a run with no commit for 31 minutes, says so in chat and notifies", async () => {
    const id = await runningTicket(31);

    expect(await handleStuckRuns(T0)).toBe(1);

    expect(resume).toHaveBeenCalledTimes(1);
    expect((await repository().ticketDetail(id))?.stuckNote).toBe("Running the tests");
    const { messages: chat } = await repository().cardChatMessages(id);
    expect(chat.map((m) => m.content)).toEqual([
      "No new commits for 30 minutes, so the Coder Agent was restarted. It was last: Running the tests",
    ]);
    const events = await repository().eventsAfter(PROJECT, 0, 50);
    expect(events.map((e) => e.payload)).toContainEqual({
      type: "run.stuck",
      ticketId: id,
      agent: "Coder Agent",
      step: "Running the tests",
    });
  });

  it("leaves a run that committed 10 minutes ago alone, however long it has run", async () => {
    await runningTicket(10);

    expect(await handleStuckRuns(T0)).toBe(0);
    expect(resume).not.toHaveBeenCalled();
    expect(STUCK_AFTER_MS).toBe(30 * MIN);
  });

  it("blocks a ticket whose restarted run is stuck too, instead of restarting it again", async () => {
    const id = await runningTicket(31, "Reading the schema");

    expect(await handleStuckRuns(T0)).toBe(1);

    expect(resume).not.toHaveBeenCalled();
    expect(stopTicket).toHaveBeenCalledTimes(1);
    const ticket = await repository().ticketDetail(id);
    expect(ticket?.status).toBe("blocked");
    expect(ticket?.blockedReason).toBe(
      "Run stuck: no new commits for 30 minutes\nFirst run last: Reading the schema\nRestarted run last: Running the tests",
    );
  });
});
