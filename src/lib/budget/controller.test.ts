import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { beginRun, recordSpend, spendFor } from "./controller";
import { budgetFor } from "./budget-for";
import { repository } from "@/lib/db";

const budget = (settings: Parameters<typeof budgetFor>[0], points = 1) =>
  budgetFor(settings, null, { storyPoints: points }, "in-process");

describe("recordSpend", () => {
  it("holds an 8-point ticket on defaults to 80 minutes clamped to the in-process window", () => {
    const b = budget(null, 8);
    expect(b.minutes.requested).toBe(80);
    expect(b.minutes.value).toBe(5);
    expect(b.minutes.clamp).toMatchObject({ rail: "in-process", enforcement: "hard-rail" });
  });

  it("stops a run at its token ceiling, counting tokens only", async () => {
    const signal = beginRun({ runId: "tok", projectId: "p", budget: budget({ tokens: { mode: "FLAT", flat: 100 } }) });
    expect(await recordSpend("tok", { cents: 9999, tokens: 99 })).toBe(true);
    expect(await recordSpend("tok", { tokens: 1 })).toBe(false);
    expect((signal.reason as Error).message).toMatch(/Token limit reached.*between turns.*retried/);
    expect(spendFor("tok")).toBeNull();
  });

  it("stops a run at its time limit", async () => {
    const signal = beginRun({ runId: "time", projectId: "p", budget: budget({ minutes: { mode: "FLAT", flat: 1 } }) });
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      expect(await recordSpend("time", {})).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect((signal.reason as Error).message).toMatch(/Time limit reached \(1 minutes\)/);
  });

  it("stops an Epic past its elapsed-time ceiling, naming it", async () => {
    const repo = repository();
    const epicId = "epic-1";
    // Three hours of run time under the Epic.
    const spy = vi.spyOn(repo, "epicRunStats").mockResolvedValue({ elapsedMs: 3 * 60 * 60 * 1000, attempts: 0 });
    const signal = beginRun({ runId: "e", projectId: "p", epicId, budget: budget(null) });
    expect(await recordSpend("e", {})).toBe(false);
    spy.mockRestore();
    expect((signal.reason as Error).message).toMatch(/Epic budget: Epic time limit reached \(120 minutes/);
  });

  it("stops an Epic past its attempt ceiling, naming it", async () => {
    const repo = repository();
    const spy = vi.spyOn(repo, "epicRunStats").mockResolvedValue({ elapsedMs: 0, attempts: 12 });
    const signal = beginRun({ runId: "a", projectId: "p", epicId: "epic-2", budget: budget(null) });
    expect(await recordSpend("a", {})).toBe(false);
    spy.mockRestore();
    expect((signal.reason as Error).message).toMatch(/Epic attempt limit reached \(12/);
  });
});

describe("auto-escalation on token overrun", () => {
  async function overrun(autoEscalate: boolean, points: number, escalated: boolean) {
    const repo = repository();
    const project = await repo.ensureProject({ ownerId: null, repoFullName: `esc/${randomUUID()}`, baseBranch: "main" });
    await repo.setAutoEscalate(project.id, autoEscalate);
    const epic = await repo.createEpic({ projectId: project.id, title: "E", rawRequest: "E", position: 1 });
    const [t] = await repo.createTickets([
      {
        epicId: epic.id,
        key: "E-1",
        title: "t",
        description: "t",
        acceptanceCriteria: [],
        fileScope: [],
        size: "S",
        position: 1,
        dependsOnKeys: [],
        storyPoints: points,
      },
    ]);
    if (escalated) await repo.markTicketAutoEscalated(t!.id);
    const runId = randomUUID();
    beginRun({
      runId,
      projectId: project.id,
      ticketId: t!.id,
      budget: budget({ tokens: { mode: "FLAT", flat: 100 } }, points),
    });
    await recordSpend(runId, { tokens: 101 });
    return { repo, id: t!.id };
  }

  it("raises 5 points to 8 and marks the ticket", async () => {
    const { repo, id } = await overrun(true, 5, false);
    const t = await repo.ticketDetail(id);
    expect(t?.storyPoints).toBe(8);
    expect(t?.autoEscalatedAt).not.toBeNull();
  });

  it("leaves points alone the second time", async () => {
    const { repo, id } = await overrun(true, 8, true);
    expect((await repo.ticketDetail(id))?.storyPoints).toBe(8);
  });

  it("does nothing when disabled", async () => {
    const { repo, id } = await overrun(false, 5, false);
    const t = await repo.ticketDetail(id);
    expect(t?.storyPoints).toBe(5);
    expect(t?.autoEscalatedAt).toBeNull();
  });
});
