import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";

const { applyCardAction, addNote, addEpicNote, columnChatAgentFor } = vi.hoisted(() => ({
  applyCardAction: vi.fn(),
  addNote: vi.fn(),
  addEpicNote: vi.fn(),
  columnChatAgentFor: vi.fn(),
}));

vi.mock("@/lib/agents/card-actions", () => ({ applyCardAction }));
vi.mock("@/lib/coder/notes", () => ({ addNote }));
vi.mock("@/lib/agents/epic-notes", () => ({ addEpicNote }));
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
  card("gate", {
    blockedReason:
      "claude-reviewer-1 is out of usage until Nov 4, 5:20 PM UTC. Wait for it, or pick an agent on another account for Building.",
    stalledIn: "in_review" as ColumnId,
  }),
  card("credit", { blockedReason: "Out of credit\nTop up" }),
]);

beforeEach(() => {
  applyCardAction.mockReset().mockResolvedValue("Starting again.");
  addNote.mockReset().mockResolvedValue(undefined);
  addEpicNote.mockReset().mockResolvedValue(undefined);
  columnChatAgentFor.mockReset().mockResolvedValue({ kind: "api" });
});

describe("ringBell", () => {
  it("starts the work again on every card stopped by a usage limit", async () => {
    expect(await ringBell(project)).toEqual({ sent: 3, skipped: 0 });
    expect(applyCardAction.mock.calls.map((c) => [c[2], c[3]]).sort()).toEqual([
      ["a", { type: "redo", instruction: MESSAGE }],
      ["b", { type: "redo", instruction: MESSAGE }],
      ["gate", { type: "redo", instruction: MESSAGE }],
    ]);
  });

  it("leaves the resume message on each card it starts", async () => {
    await ringBell(project);
    expect(addNote.mock.calls.map((c) => [c[1], c[2]]).sort()).toEqual([
      ["a", MESSAGE],
      ["b", MESSAGE],
      ["gate", MESSAGE],
    ]);
  });

  it("skips a card whose agent is still limited and starts the rest", async () => {
    columnChatAgentFor.mockResolvedValueOnce({ kind: "limited", reason: "out" });
    expect(await ringBell(project)).toEqual({ sent: 2, skipped: 1 });
    expect(applyCardAction).toHaveBeenCalledTimes(2);
  });

  it("restarts a start-gate limit stop in the column it stopped in", async () => {
    await ringBell(project);
    expect(columnChatAgentFor).toHaveBeenCalledWith(project, "in_review");
  });

  it("leaves cards stopped for other reasons alone", async () => {
    await ringBell(project);
    expect(applyCardAction.mock.calls.map((c) => c[2])).not.toContain("credit");
  });
});
