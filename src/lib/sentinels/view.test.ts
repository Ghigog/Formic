import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@/lib/db/repository";
import { STALE_AFTER_MS, sentinelStates } from "./view";

const T0 = Date.parse("2026-09-27T10:00:00Z");

function audit(patch: Partial<AuditRecord>): AuditRecord {
  return {
    id: Math.random().toString(36),
    projectId: "p",
    sentinel: "secops",
    status: "done",
    log: [],
    stars: 3,
    quote: "q",
    summary: "s",
    report: { likes: [], dislikes: [], wrong: [], missing: [] },
    error: null,
    model: "m",
    files: [],
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
});
