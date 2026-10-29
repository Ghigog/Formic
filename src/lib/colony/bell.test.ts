import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";

const { ask, columnChatAgentFor } = vi.hoisted(() => ({ ask: vi.fn(), columnChatAgentFor: vi.fn() }));

class ChatBusyError extends Error {}
vi.mock("@/lib/agents/card-chat", () => ({ ask, ChatBusyError }));
vi.mock("@/lib/agents/presets", () => ({ columnChatAgentFor }));

const { MemoryRepository, seedMemory } = await import("@/lib/db/memory-repository");
const repo = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));
const { ringBell } = await import("./bell");

function card(id: string, over: Partial<BoardCard>): BoardCard {
  return {
    id,
    kind: "ticket",
    key: id.toUpperCase(),
    title: "Some work",
    status: "failed",
    stalledIn: "building" as ColumnId,
    stage: 3,
    position: 0,
    epicId: null,
    size: null,
    agentRole: null,
    model: null,
    fileScope: [],
    dependsOn: [],
    prNumber: null,
    prUrl: null,
    blockedReason: "Usage limit reached\nresets at noon",
    costCents: 0,
    childCount: 0,
    doneCount: 0,
    ...over,
  } as BoardCard;
}

const MESSAGE = "Your token limit has been restored. Please resume your work.";
const project = "project_default";

seedMemory([
  card("a", {}),
  card("b", {}),
  card("credit", { blockedReason: "Out of credit\nTop up" }),
]);

beforeEach(() => {
  ask.mockReset().mockResolvedValue(undefined);
  columnChatAgentFor.mockReset().mockResolvedValue({ kind: "api" });
});

describe("ringBell", () => {
  it("sends the resume message to every card stopped by a usage limit", async () => {
    expect(await ringBell(project)).toEqual({ sent: 2, skipped: 0 });
    expect(ask.mock.calls.map((c) => [c[2], c[3]]).sort()).toEqual([
      ["a", MESSAGE],
      ["b", MESSAGE],
    ]);
  });

  it("skips a card whose agent is still limited and sends the rest", async () => {
    columnChatAgentFor.mockResolvedValueOnce({ kind: "limited", reason: "out" });
    expect(await ringBell(project)).toEqual({ sent: 1, skipped: 1 });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("skips a card whose chat is busy and carries on", async () => {
    ask.mockRejectedValueOnce(new ChatBusyError());
    expect(await ringBell(project)).toEqual({ sent: 1, skipped: 1 });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("leaves cards stopped for other reasons alone", async () => {
    await ringBell(project);
    expect(ask.mock.calls.map((c) => c[2])).not.toContain("credit");
  });
});
