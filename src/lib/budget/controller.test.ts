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
