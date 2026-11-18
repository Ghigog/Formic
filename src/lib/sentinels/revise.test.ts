import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditRecord, Rubric, RubricFix } from "@/lib/db/repository";

const PATH = "app/src/main/java/com/juice/overlay/OverlayService.kt";
const rubric: Rubric = {
  context: "An Android app",
  rungs: [
    { stars: 3, checks: [{ id: "3a", text: "Three a", how: "read" }] },
    { stars: 5, checks: [{ id: "5b", text: "Names app/OldService.kt", how: "read it" }, { id: "5c", text: "Five c", how: "read" }] },
  ],
};
const check = { text: `Overlay logic lives in ${PATH}`, how: `Read ${PATH}`, command: null, pass: null };

let calibration: AuditRecord;
let revision: AuditRecord;
let fix: RubricFix;
const reviseCalibration = vi.fn(async (_id: string, r: Rubric) => {
  calibration.rubric = r;
});
const postPmMessage = vi.fn(async (..._a: unknown[]) => ({ id: "m" }));

vi.mock("@/lib/db", () => ({
  repository: () => ({
    auditDetail: async (id: string) => (id === revision.id ? revision : calibration),
    auditsFor: async () => [calibration, revision],
    rubricFixesFor: async () => [fix],
    updateRubricFix: async (_id: string, patch: Partial<RubricFix>) => (fix = { ...fix, ...patch }),
    reviseCalibration,
  }),
}));
vi.mock("@/lib/assistant/pm-messages", () => ({ postPmMessage: (...a: unknown[]) => postPmMessage(...a) }));

const rewriteOther = vi.hoisted(() => ({ on: false }));
vi.mock("./rubric-fix", async (orig) => {
  const real = await orig<typeof import("./rubric-fix")>();
  return {
    ...real,
    // Stands in for a revision that also rewrites check 3a.
    reviseCheck: (...a: Parameters<typeof real.reviseCheck>) => {
      const r = real.reviseCheck(...a);
      if (!rewriteOther.on) return r;
      const first = r.rungs[0]!;
      return { ...r, rungs: [{ ...first, checks: [{ ...first.checks[0]!, text: "Lowered bar" }] }, ...r.rungs.slice(1)] };
    },
  };
});

import { landRevision } from "./revise";

const audit = (over: Partial<AuditRecord>): AuditRecord =>
  ({ projectId: "p", sentinel: "architect", status: "done", rubric: null, ...over }) as AuditRecord;

beforeEach(() => {
  vi.clearAllMocks();
  rewriteOther.on = false;
  calibration = audit({ id: "c1", kind: "calibrate", rubric });
  revision = audit({ id: "r1", kind: "revise", status: "running", rubric });
  fix = {
    id: "f1", projectId: "p", sentinel: "architect", checkId: "5b", problem: "wrong path", suggestion: PATH,
    ticketId: "t", ticketKey: "EPIC-110-T5", flaggedBy: null, status: "revising", messageId: null,
    before: null, after: null, approvedBy: "u1", approvedAt: new Date("2026-01-01"), appliedAt: null, error: null,
    createdAt: new Date(),
  };
});

describe("landRevision", () => {
  it("saves nothing for a fix that is not approved", async () => {
    fix = { ...fix, status: "proposed", approvedBy: null, approvedAt: null };
    expect((await landRevision("r1", check)).ok).toBe(false);
    expect(reviseCalibration).not.toHaveBeenCalled();
    expect(calibration.rubric).toEqual(rubric);
  });

  it("changes only the approved check and records before, after, who and when", async () => {
    const landed = await landRevision("r1", check);
    expect(landed.ok).toBe(true);
    const saved = calibration.rubric!;
    expect(saved.context).toBe(rubric.context);
    expect(saved.rungs.map((r) => r.stars)).toEqual([3, 5]);
    expect(saved.rungs[0]).toEqual(rubric.rungs[0]);
    expect(saved.rungs[1]!.checks[1]).toEqual(rubric.rungs[1]!.checks[1]);
    expect(saved.rungs[1]!.checks[0]).toEqual({ id: "5b", ...check });
    expect(fix).toMatchObject({ status: "applied", approvedBy: "u1", before: rubric.rungs[1]!.checks[0] });
    expect(fix.after).toMatchObject({ id: "5b", text: check.text });
    expect(fix.approvedAt).toEqual(new Date("2026-01-01"));
  });

  it("tells the person the new wording and offers to close the flagging card", async () => {
    await landRevision("r1", check);
    const msg = postPmMessage.mock.calls[0]![1] as { content: string; proposals: Array<{ action: unknown }> };
    expect(msg.content).toContain(`\`${PATH}\``);
    expect(msg.content).toContain("`5b`");
    expect(msg.proposals[0]!.action).toMatchObject({ type: "close_card", key: "EPIC-110-T5" });
  });

  it("refuses a check that is not in the rubric: nothing saved, the fix failed, the PM says so", async () => {
    fix = { ...fix, checkId: "3z" };
    expect((await landRevision("r1", check)).ok).toBe(false);
    expect(reviseCalibration).not.toHaveBeenCalled();
    expect(fix.status).toBe("failed");
    expect((postPmMessage.mock.calls[0]![1] as { content: string }).content).toContain("did not change");
  });

  it("fails the fix when the rubric was recalibrated during the run", async () => {
    calibration.rubric = { ...rubric, rungs: [{ stars: 3, checks: [{ id: "3a", text: "Rewritten", how: "read" }] }, rubric.rungs[1]!] };
    expect((await landRevision("r1", check)).ok).toBe(false);
    expect(reviseCalibration).not.toHaveBeenCalled();
    expect(fix.status).toBe("failed");
  });

  it("rejects a revision that also rewrites check 3a: nothing saved, the PM says it was not changed", async () => {
    rewriteOther.on = true;
    expect((await landRevision("r1", check)).ok).toBe(false);
    expect(reviseCalibration).not.toHaveBeenCalled();
    expect(calibration.rubric).toEqual(rubric);
    expect(fix.status).toBe("failed");
    expect((postPmMessage.mock.calls[0]![1] as { content: string }).content).toContain("did not change");
  });
});
