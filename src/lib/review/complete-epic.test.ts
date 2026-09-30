import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEpicWithChildren } from "@/test/cards";

const spent = vi.hoisted(() => ({
  startRun: vi.fn(),
  startCliAnswer: vi.fn(),
  summarize: vi.fn(),
  launch: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/lib/agents/pipeline", () => ({
  startRun: spent.startRun,
  launch: spent.launch,
  applyShowcase: vi.fn(),
}));
vi.mock("@/lib/runner/runner", () => ({
  cliPrompt: vi.fn(),
  showcaseSummaries: vi.fn(() => []),
  startCliAnswer: spent.startCliAnswer,
  startJobRun: vi.fn(),
}));
vi.mock("@/lib/agents/presets", () => ({
  agentFor: vi.fn(async () => ({ summarize: spent.summarize })),
  cliAgentFor: vi.fn(async () => null),
  runTargetFor: vi.fn(async () => ({})),
}));
vi.mock("@/lib/events/bus", () => ({ publish: spent.publish }));

const { completeEpic } = await import("./pipeline");
const { repository } = await import("@/lib/db");
const { seedMemory } = await import("@/lib/db/memory-repository");

const PROJECT = "project_default";

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__formicMemoryStore = undefined;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL;
});

describe("completeEpic", () => {
  it("moves the Epic to Done and starts no PM run, so no usage is spent", async () => {
    const [epic, ...kids] = makeEpicWithChildren({ status: "ready" }, [{ status: "merged" }, { status: "merged" }]);
    seedMemory([epic!, ...kids]);

    await completeEpic(PROJECT, epic!.id);

    expect(await repository().cardById(epic!.id)).toMatchObject({ status: "merged" });
    expect(spent.publish).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ type: "card.status", cardId: epic!.id, status: "merged" }),
    );
    expect(spent.startRun).not.toHaveBeenCalled();
    expect(spent.startCliAnswer).not.toHaveBeenCalled();
    expect(spent.summarize).not.toHaveBeenCalled();
    expect(spent.launch).not.toHaveBeenCalled();
  });
});
