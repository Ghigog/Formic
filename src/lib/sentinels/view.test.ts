import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@/lib/db/repository";
import { STALE_AFTER_MS, sentinelStates } from "./view";

const T0 = Date.parse("2026-09-27T10:00:00Z");

function audit(patch: Partial<AuditRecord>): AuditRecord {
  return {
    id: Math.random().toString(36),
    projectId: "p",
    sentinel: "secops",
    kind: "audit",
    status: "done",
    log: [],
    stars: 3,
    quote: "q",
    summary: "s",
    report: { likes: [], dislikes: [], wrong: [], missing: [] },
    rubric: null,
    error: null,
    model: "m",
    files: [],
    commitSha: null,
    runnerJob: null,
    runnerAgent: null,
    epicId: null,
    startedAt: new Date(T0),
    finishedAt: new Date(T0 + 1000),
    ...patch,
  };
}

describe("sentinelStates", () => {
  it("has every sentinel, unaudited ones empty", () => {
    const s = sentinelStates([], T0);
    expect(Object.keys(s)).toHaveLength(12);
    expect(s.secops).toMatchObject({ stars: null, running: null, error: null });
  });

  it("carries the newest audit's commit, and null for one without", () => {
    const first = audit({ commitSha: "abc1234", startedAt: new Date(T0) });
    const second = audit({ commitSha: "def5678", startedAt: new Date(T0 + 5000), finishedAt: new Date(T0 + 6000) });
    expect(sentinelStates([first, second], T0).secops!.commitSha).toBe("def5678");
    expect(sentinelStates([first], T0).secops).toMatchObject({ commitSha: "abc1234", at: new Date(T0 + 1000).toISOString() });
    expect(sentinelStates([audit({})], T0).secops!.commitSha).toBeNull();
  });

  it("exposes the epic made from the latest done audit", () => {
    const marked = audit({ id: "a1", epicId: "e1" });
    expect(sentinelStates([marked], T0).secops).toMatchObject({ auditId: "a1", epicId: "e1" });
    const newer = audit({ startedAt: new Date(T0 + 5000) });
    expect(sentinelStates([marked, newer], T0 + 9000).secops!.epicId).toBeNull();
    const running = audit({ status: "running", stars: null, startedAt: new Date(T0 + 5000) });
    expect(sentinelStates([marked, running], T0 + 6000).secops!.epicId).toBe("e1");
    const failed = audit({ status: "failed", stars: null, startedAt: new Date(T0 + 5000) });
    expect(sentinelStates([marked, failed], T0 + 6000).secops!.epicId).toBe("e1");
  });

  it("keeps the last report while a new run is going", () => {
    const s = sentinelStates(
      [audit({ stars: 4 }), audit({ status: "running", stars: null, log: ["Listing files"], startedAt: new Date(T0 + 5000) })],
      T0 + 6000,
    );
    expect(s.secops!.stars).toBe(4);
    expect(s.secops!.running?.log).toEqual(["Listing files"]);
  });

  it("keeps the last report when the new run fails, and says why", () => {
    const s = sentinelStates(
      [audit({ stars: 2 }), audit({ status: "failed", stars: null, error: "No key", startedAt: new Date(T0 + 5000) })],
      T0 + 6000,
    );
    expect(s.secops).toMatchObject({ stars: 2, error: "No key", running: null });
  });

  it("treats a run that never finished as failed", () => {
    const s = sentinelStates([audit({ status: "running", stars: null })], T0 + STALE_AFTER_MS + 1);
    expect(s.secops!.running).toBeNull();
    expect(s.secops!.error).toMatch(/stopped/);
  });

  it("keeps the rubric apart from the report, and says when it changed since", () => {
    const rubric = (bar: string) => ({ context: "c", rungs: [{ stars: 2, checks: [{ id: "2a", text: bar, how: "h" }] }] });
    const calibration = audit({ kind: "calibrate", stars: null, report: null, rubric: rubric("old"), startedAt: new Date(T0 - 9000) });
    const scored = audit({ rubric: rubric("old") });
    let s = sentinelStates([calibration, scored], T0 + 2000).secops!;
    expect(s).toMatchObject({ stars: 3, rubric: { rubric: rubric("old") }, rubricChanged: false, running: null, error: null });

    const again = audit({ kind: "calibrate", stars: null, report: null, rubric: rubric("new"), startedAt: new Date(T0 + 5000) });
    s = sentinelStates([calibration, scored, again], T0 + 9000).secops!;
    expect(s).toMatchObject({ stars: 3, rubric: { rubric: rubric("new") }, scoredWith: rubric("old"), rubricChanged: true });

    const running = audit({ kind: "calibrate", status: "running", stars: null, rubric: null, startedAt: new Date(T0 + 8000) });
    s = sentinelStates([calibration, scored, running], T0 + 9000).secops!;
    expect(s.running).toMatchObject({ kind: "calibrate" });
    expect(s.rubric?.rubric).toEqual(rubric("old"));
  });
});
