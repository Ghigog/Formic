import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** Cards stopped by a limit, per board; ringBell restarts up to `max` of them. */
const stopped = vi.hoisted(() => new Map<string, number>());
vi.mock("@/lib/colony/bell", () => ({
  limitStoppedCards: async (projectId: string) => Array.from({ length: stopped.get(projectId) ?? 0 }, (_, i) => ({ id: `${projectId}-${i}` })),
  ringBell: async (projectId: string, max = Infinity) => {
    const n = stopped.get(projectId) ?? 0;
    const sent = Math.min(n, max);
    stopped.set(projectId, n - sent);
    return { sent, skipped: 0, left: n - sent };
  },
}));

const used = vi.hoisted(() => [] as string[]);
const owners: Record<string, string> = { a: "me", b: "me", c: "someone-else" };
vi.mock("@/lib/db", () => ({
  repository: () => ({
    goldenBell: async () => ({ armed: true }),
    projectById: async (id: string) => ({ id, ownerId: owners[id] }),
    columnAgents: async () => ({ building: "p1" }),
    listPresets: async () => [{ id: "p1", limitedUntil: new Date(0).toISOString() }],
    useGoldenBell: async (id: string) => void used.push(id),
  }),
}));

const { BELL_BATCH, BELL_GAP_MS, resetBellBatches, ringBellIfDue } = await import("./bell");

const NOW = 1_000_000_000;

beforeEach(() => {
  stopped.clear();
  used.length = 0;
  resetBellBatches();
});

describe("the golden bell's batches", () => {
  it("restarts at most five cards across one person's boards, then the rest after the gap", async () => {
    expect(BELL_BATCH).toBe(5);
    stopped.set("a", 4).set("b", 4);
    await ringBellIfDue("a", NOW);
    await ringBellIfDue("b", NOW);
    expect(stopped.get("a")).toBe(0);
    expect(stopped.get("b")).toBe(3);
    expect(used).toEqual(["a"]);

    // Within the gap, nothing more on this account.
    expect(await ringBellIfDue("b", NOW + 60_000)).toBe(false);
    expect(stopped.get("b")).toBe(3);

    await ringBellIfDue("b", NOW + BELL_GAP_MS);
    expect(stopped.get("b")).toBe(0);
    expect(used).toEqual(["a", "b"]);
  });

  it("gives one board all five when it is the only one", async () => {
    stopped.set("a", 7);
    await ringBellIfDue("a", NOW);
    expect(stopped.get("a")).toBe(2);
  });

  it("keeps each account's batch apart", async () => {
    stopped.set("a", 5).set("c", 5);
    await ringBellIfDue("a", NOW);
    await ringBellIfDue("c", NOW);
    expect(stopped.get("a")).toBe(0);
    expect(stopped.get("c")).toBe(0);
  });
});
