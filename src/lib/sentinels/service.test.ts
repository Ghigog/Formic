import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard } from "@/lib/domain/entities";

let cards: BoardCard[] = [];
let audits: unknown[] = [];
let job: (() => Promise<void>) | null = null;

const startAudit = vi.fn(async (..._args: unknown[]) => ({ id: "a1" }));
const logAudit = vi.fn(async (..._args: unknown[]) => {});
const finishAudit = vi.fn(async (..._args: unknown[]) => {});
const sentinelAgent = vi.fn();
const startCliSentinel = vi.fn();
const projectFor = vi.fn();
const credentialsForProject = vi.fn();
const listFiles = vi.fn();
const snapshot = vi.fn();
const readFile = vi.fn();
const gatherEvidence = vi.fn();
const runAudit = vi.fn();
const branchHead = vi.fn(async (..._args: unknown[]): Promise<string | null> => null);

vi.mock("@/lib/db", () => ({
  repository: () => ({
    boardCards: async () => cards,
    auditsFor: async () => audits,
    startAudit,
    logAudit,
    finishAudit,
  }),
}));
vi.mock("@/lib/agents/pipeline", () => ({
  launch: (fn: () => Promise<void>) => {
    job = fn;
  },
}));
vi.mock("@/lib/agents/presets", () => ({ sentinelAgent: (...a: unknown[]) => sentinelAgent(...a) }));
vi.mock("@/lib/runner/runner", () => ({ startCliSentinel: (...a: unknown[]) => startCliSentinel(...a) }));
vi.mock("@/lib/board/project", () => ({ projectFor: (...a: unknown[]) => projectFor(...a) }));
vi.mock("@/lib/auth/credentials", () => ({ credentialsForProject: (...a: unknown[]) => credentialsForProject(...a) }));
vi.mock("@/lib/vcs", () => ({ vcs: () => ({ listFiles, snapshot, readFile, branchHead }) }));
vi.mock("./gather", () => ({ gatherEvidence: (...a: unknown[]) => gatherEvidence(...a) }));
vi.mock("./agent", () => ({ runAudit: (...a: unknown[]) => runAudit(...a) }));

import { sentinelsFor, summonSentinel } from "./service";
import { SENTINELS } from "./roster";
import { cannedRubric } from "./rubric";

const merged = (n: number): BoardCard[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    kind: "ticket",
    status: "merged",
    mergePoints: 50,
  })) as BoardCard[];

const locked = SENTINELS.find((s) => s.unlockLevel === 6)!;
const rubric = cannedRubric(locked);

const calibrated = {
  id: "c1",
  sentinel: locked.id,
  kind: "calibrate",
  status: "done",
  rubric,
  startedAt: new Date(1000).toISOString(),
  finishedAt: new Date(2000),
  model: "m",
  log: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  cards = merged(5); // 250 XP: Lv 6
  audits = [];
  job = null;
});

async function runJob() {
  expect(job).not.toBeNull();
  await job!();
}

describe("sentinelsFor", () => {
  it("has a state for every sentinel, from the journal", async () => {
    audits = [calibrated];
    const states = await sentinelsFor("p");
    expect(Object.keys(states).sort()).toEqual(SENTINELS.map((s) => s.id).sort());
    expect(states[locked.id]!.rubric?.rubric).toEqual(rubric);
  });
});

describe("summonSentinel", () => {
  it("refuses an unknown sentinel", async () => {
    expect(await summonSentinel("p", "nobody")).toEqual({ ok: false, error: "No such sentinel.", status: 404 });
  });

  it("refuses a Sentinel the colony has not unlocked", async () => {
    cards = []; // Lv 1
    const r = await summonSentinel("p", locked.id);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(startAudit).not.toHaveBeenCalled();
  });

  it("runs it once the colony reaches its level, calibrating before it audits", async () => {
    expect(await summonSentinel("p", locked.id)).toMatchObject({ ok: false, status: 409 });
    expect(startAudit).not.toHaveBeenCalled();
    expect(await summonSentinel("p", locked.id, "calibrate")).toEqual({ ok: true });
    expect(startAudit).toHaveBeenCalledWith("p", locked.id, "calibrate", null, null);
  });

  it("audits against the calibrated rubric", async () => {
    audits = [calibrated];
    expect(await summonSentinel("p", locked.id)).toEqual({ ok: true });
    expect(startAudit).toHaveBeenCalledWith("p", locked.id, "audit", rubric, null);
  });

  it("stamps the audit with the base branch head, or null when it cannot be resolved", async () => {
    audits = [calibrated];
    projectFor.mockResolvedValue({ repoFullName: "o/r", baseBranch: "main" });
    credentialsForProject.mockResolvedValue({ githubToken: "tok" });
    branchHead.mockResolvedValueOnce("abc1234");
    await summonSentinel("p", locked.id);
    expect(branchHead).toHaveBeenCalledWith("main");
    expect(startAudit).toHaveBeenLastCalledWith("p", locked.id, "audit", rubric, "abc1234");

    branchHead.mockRejectedValueOnce(new Error("rate limited"));
    expect(await summonSentinel("p", locked.id)).toEqual({ ok: true });
    expect(startAudit).toHaveBeenLastCalledWith("p", locked.id, "audit", rubric, null);
  });

  it("does not start a second run while one is running", async () => {
    audits = [
      calibrated,
      { id: "r", sentinel: locked.id, kind: "audit", status: "running", startedAt: new Date().toISOString(), log: [] },
    ];
    expect(await summonSentinel("p", locked.id)).toEqual({ ok: true });
    expect(startAudit).not.toHaveBeenCalled();
  });
});

describe("the detached run", () => {
  const start = async (kind: "audit" | "calibrate" = "calibrate") => {
    audits = kind === "audit" ? [calibrated] : [];
    await summonSentinel("p", locked.id, kind);
  };

  it("fails with the reason when no agent can run it", async () => {
    sentinelAgent.mockResolvedValue({ kind: "none", reason: "No agent." });
    await start();
    await runJob();
    expect(logAudit).toHaveBeenCalledWith("a1", "Listing files");
    expect(finishAudit).toHaveBeenCalledWith("a1", { status: "failed", error: "No agent.", model: null });
  });

  it("hands a CLI agent's run to GitHub Actions, and fails if it cannot start", async () => {
    const agent = { info: { label: "Claude Code" } };
    sentinelAgent.mockResolvedValue({ kind: "cli", agent });
    startCliSentinel.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: "No runner." });
    await start();
    await runJob();
    expect(startCliSentinel).toHaveBeenCalledWith({
      projectId: "p",
      auditId: "a1",
      sentinelId: locked.id,
      goal: { kind: "calibrate" },
      agent,
    });
    expect(finishAudit).not.toHaveBeenCalled();

    await start();
    await runJob();
    expect(finishAudit).toHaveBeenCalledWith("a1", { status: "failed", error: "No runner.", model: null });
  });

  it("writes a canned rubric and report for a mock agent", async () => {
    vi.useFakeTimers();
    try {
      sentinelAgent.mockResolvedValue({ kind: "mock" });
      await start();
      let p = runJob();
      await vi.runAllTimersAsync();
      await p;
      expect(finishAudit).toHaveBeenLastCalledWith("a1", expect.objectContaining({ status: "done", model: "mock", rubric: expect.anything() }));

      await start("audit");
      p = runJob();
      await vi.runAllTimersAsync();
      await p;
      expect(finishAudit).toHaveBeenLastCalledWith(
        "a1",
        expect.objectContaining({ status: "done", model: "mock", stars: expect.any(Number), report: expect.anything() }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("with a configured agent", () => {
    const config = { provider: "x" };
    const project = { repoFullName: "o/r", baseBranch: "main" };
    beforeEach(() => {
      sentinelAgent.mockResolvedValue({ kind: "configured", config });
      projectFor.mockResolvedValue(project);
      credentialsForProject.mockResolvedValue({ githubToken: "tok" });
      listFiles.mockResolvedValue(["a.ts", "big.ts"]);
      gatherEvidence.mockResolvedValue({});
    });

    it("fails when the project has no GitHub access", async () => {
      credentialsForProject.mockResolvedValue({ githubToken: null });
      await start();
      await runJob();
      expect(finishAudit).toHaveBeenCalledWith("a1", expect.objectContaining({ status: "failed", error: expect.stringContaining("no GitHub access") }));
      expect(runAudit).not.toHaveBeenCalled();
    });

    it("reads from the snapshot, falls back to GitHub, and saves the outcome", async () => {
      snapshot.mockResolvedValue({ files: new Map([["a.ts", Buffer.from("snap")]]) });
      readFile.mockResolvedValue("remote");
      runAudit.mockImplementation(async (_cfg, input) => {
        expect(await input.read("a.ts")).toBe("snap");
        expect(await input.read("big.ts")).toBe("remote");
        return { ok: true, summary: "s", usage: { model: "m1" } };
      });
      await start();
      await runJob();
      expect(readFile).toHaveBeenCalledWith("big.ts", "main");
      expect(finishAudit).toHaveBeenCalledWith("a1", { status: "done", summary: "s", model: "m1" });
    });

    it("keeps going without a snapshot, and fails with the audit's error", async () => {
      snapshot.mockRejectedValue(new Error("too big"));
      runAudit.mockResolvedValue({ ok: false, error: "Bad.", usage: { model: "m1" } });
      await start();
      await runJob();
      expect(gatherEvidence).toHaveBeenCalledWith(expect.objectContaining({ snapshot: null }));
      expect(finishAudit).toHaveBeenCalledWith("a1", { status: "failed", error: "Bad.", model: "m1" });
    });

    it("fails with the thrown message, or a default for a non-error", async () => {
      sentinelAgent.mockRejectedValueOnce(new Error("boom"));
      await start();
      await runJob();
      expect(finishAudit).toHaveBeenLastCalledWith("a1", { status: "failed", error: "boom", model: null });

      sentinelAgent.mockRejectedValueOnce("x");
      await start();
      await runJob();
      expect(finishAudit).toHaveBeenLastCalledWith("a1", { status: "failed", error: "Calibrating failed.", model: null });

      sentinelAgent.mockRejectedValueOnce("x");
      await start("audit");
      await runJob();
      expect(finishAudit).toHaveBeenLastCalledWith("a1", { status: "failed", error: "The audit failed.", model: null });
    });
  });
});
