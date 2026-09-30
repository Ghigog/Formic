import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const { repository } = await import("@/lib/db");
const {
  CHAT_ORPHAN_AFTER_MS,
  ORPHAN_AFTER_MS,
  reconcileOrphanedRuns,
  recoverStaleAssistantAnswers,
  recoverStaleCardChats,
  resetChatRecovery,
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
