import { beforeEach, describe, expect, it, vi } from "vitest";

const { publish } = vi.hoisted(() => ({ publish: vi.fn(async () => 1) }));
vi.mock("@/lib/events/bus", () => ({ publish }));
vi.mock("server-only", () => ({}));

import { repository } from "@/lib/db";
import { resetMemoryStore } from "@/lib/db/memory-repository";
import { postPmMessage } from "./pm-messages";

describe("postPmMessage", () => {
  beforeEach(() => {
    resetMemoryStore();
    publish.mockClear();
  });

  it("stores a done PM message with its card links and publishes assistant.message", async () => {
    const project = await repository().ensureProject({ ownerId: null, repoFullName: "acme/pm", baseBranch: "main" });
    const card = { id: "c1", key: "ACME-1", title: "Follow up" };
    const posted = await postPmMessage(project.id, { content: "Worth doing?", cards: [card] });

    const { messages } = await repository().assistantMessages(project.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", status: "done", speaker: "assistant", cards: [card] });
    expect(publish).toHaveBeenCalledWith(project.id, { type: "assistant.message", messageId: posted.id });
  });
});
