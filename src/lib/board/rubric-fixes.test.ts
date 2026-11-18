import { beforeEach, describe, expect, it, vi } from "vitest";

const { sentinelsFor, proposeRubricFixes } = vi.hoisted(() => ({
  sentinelsFor: vi.fn(),
  proposeRubricFixes: vi.fn(async () => undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentinels/service", () => ({ sentinelsFor }));
vi.mock("@/lib/assistant/rubric-fix-messages", () => ({ proposeRubricFixes }));

import { repository } from "@/lib/db";
import { recordRubricFixes } from "./rubric-fixes";

const PROJECT = "project_default";
const RUBRIC = {
  context: "c",
  rungs: [{ stars: 1, checks: [{ id: "5b", text: "Reads app/OverlayService.kt", how: "h", command: null, pass: "p" }] }],
};
const flag = { sentinel: "architect", check: "5b", problem: "Wrong file.", suggestion: "Use app/src/main/java/com/juice/overlay/OverlayService.kt" };

async function seed() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "r", position: 1 });
  const [ticket] = await repo.createTickets([
    { epicId: epic.id, key: `${epic.key}-T1`, title: "T", description: "d", acceptanceCriteria: [], fileScope: [], storyPoints: 1, position: 1, dependsOnKeys: [] },
  ]);
  return ticket!;
}

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  vi.clearAllMocks();
  sentinelsFor.mockResolvedValue({ architect: { rubric: { rubric: RUBRIC } } });
});

describe("recordRubricFixes", () => {
  it("records a flag linked to the ticket and proposes it, leaving the rubric alone", async () => {
    const ticket = await seed();
    await recordRubricFixes(ticket.id, [flag]);
    const [fix, ...rest] = await repository().rubricFixesFor(PROJECT);
    expect(rest).toEqual([]);
    expect(fix).toMatchObject({ sentinel: "architect", checkId: "5b", ticketId: ticket.id, ticketKey: ticket.key, status: "flagged" });
    expect(proposeRubricFixes).toHaveBeenCalledWith(PROJECT, [fix!.id]);
    expect(RUBRIC.rungs[0]!.checks[0]!.text).toBe("Reads app/OverlayService.kt");
  });

  it("ignores a check the rubric does not have, and a Sentinel with no rubric", async () => {
    const ticket = await seed();
    await recordRubricFixes(ticket.id, [{ ...flag, check: "9z" }, { ...flag, sentinel: "other" }]);
    expect(await repository().rubricFixesFor(PROJECT)).toEqual([]);
    expect(proposeRubricFixes).not.toHaveBeenCalled();
  });

  it("ignores a check already open for the same Sentinel", async () => {
    const ticket = await seed();
    await recordRubricFixes(ticket.id, [flag]);
    await recordRubricFixes(ticket.id, [flag, flag]);
    expect(await repository().rubricFixesFor(PROJECT)).toHaveLength(1);
    expect(proposeRubricFixes).toHaveBeenCalledTimes(1);
  });
});
