import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const stopped = vi.hoisted(() => [] as string[]);
const cancelled = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/budget/controller", async (original) => ({
  ...(await original<object>()),
  stopEpic: vi.fn(async (epicId: string) => void stopped.push(epicId)),
}));
vi.mock("@/lib/runner/runner", async (original) => ({
  ...(await original<object>()),
  cancelJob: vi.fn(async (_p: string, job: string) => void cancelled.push(job)),
}));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async () => 1) }));

const { repository } = await import("@/lib/db");
const { stopEpicAgent } = await import("./card-actions");

/** Stop on an Epic: the agent writing its PRD stops, and one with tickets is planned from them. */

const PROJECT = "project_default";

async function epicWritingItsPrd(withTickets: boolean) {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Make CI faster", rawRequest: "CI is slow.", position: 1 });
  await repo.move({ cardId: epic.id, kind: "epic", status: "waiting", stalledIn: null, position: 1 });
  await repo.setEpicRunnerJob(epic.id, "job-1");
  if (withTickets) {
    await repo.createTickets([
      { epicId: epic.id, key: `${epic.key}-T1`, title: "Measure", description: "d", acceptanceCriteria: ["c"], fileScope: [], position: 2, dependsOnKeys: [] },
    ]);
  }
  return epic;
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  stopped.length = 0;
  cancelled.length = 0;
});

describe("stopEpicAgent", () => {
  it("stops the agent and its job, and plans an Epic that has its tickets from them", async () => {
    const epic = await epicWritingItsPrd(true);
    expect(await stopEpicAgent(PROJECT, epic.id)).toBe(true);
    expect(stopped).toEqual([epic.id]);
    expect(cancelled).toEqual(["job-1"]);
    const detail = await repository().epicDetail(epic.id);
    expect(detail?.runnerJob).toBeNull();
    expect(detail?.prd).toMatchObject({ scope: [`${epic.key}-T1: Measure`] });
    expect((await repository().cardById(epic.id))?.status).toBe("ready");
  });

  it("only stops an Epic with no tickets: its PRD is still to write", async () => {
    const epic = await epicWritingItsPrd(false);
    expect(await stopEpicAgent(PROJECT, epic.id)).toBe(true);
    expect((await repository().epicDetail(epic.id))?.prd).toBeNull();
  });

  it("says when nothing is working on it", async () => {
    const epic = await repository().createEpic({ projectId: PROJECT, title: "Idle", rawRequest: "r", position: 1 });
    expect(await stopEpicAgent(PROJECT, epic.id)).toBe(false);
    expect(stopped).toEqual([]);
  });
});
