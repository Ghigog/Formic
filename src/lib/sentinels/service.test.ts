import { describe, expect, it, vi } from "vitest";
import type { BoardCard } from "@/lib/domain/entities";

const startAudit = vi.fn(async () => ({ id: "a1" }));
let cards: BoardCard[] = [];

vi.mock("@/lib/db", () => ({
  repository: () => ({
    boardCards: async () => cards,
    auditsFor: async () => [],
    startAudit,
    logAudit: async () => {},
    finishAudit: async () => {},
  }),
}));
vi.mock("@/lib/agents/pipeline", () => ({ launch: () => {} }));

import { summonSentinel } from "./service";
import { SENTINELS } from "./roster";

const merged = (n: number): BoardCard[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    kind: "ticket",
    status: "merged",
    mergePoints: 50,
  })) as BoardCard[];

describe("summonSentinel", () => {
  const locked = SENTINELS.find((s) => s.unlockLevel === 3)!;

  it("refuses a Sentinel the colony has not unlocked", async () => {
    cards = []; // Lv 1
    const r = await summonSentinel("p", locked.id);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(startAudit).not.toHaveBeenCalled();
  });

  it("runs it once the colony reaches its level", async () => {
    cards = merged(2); // 100 XP: Lv 3
    expect(await summonSentinel("p", locked.id)).toEqual({ ok: true });
    expect(startAudit).toHaveBeenCalledOnce();
  });
});
