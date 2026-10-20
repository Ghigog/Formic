import { describe, expect, it } from "vitest";
import type { BoardCard } from "@/lib/domain/entities";
import {
  AUTO_SCOUT_LEVEL,
  colonyAdmits,
  effectiveColony,
  maxScouts,
  nextFloorLevel,
  reserveFloor,
  slotsInUse,
} from "./reserve";

function card(p: Partial<BoardCard> & Pick<BoardCard, "id">): BoardCard {
  return {
    kind: "ticket",
    key: p.id.toUpperCase(),
    title: "Some work",
    status: "queued",
    stalledIn: null,
    stage: 3,
    position: 0,
    epicId: null,
    size: null,
    agentRole: null,
    model: null,
    fileScope: [],
    dependsOn: [],
    prNumber: null,
    prUrl: null,
    blockedReason: null,
    costCents: 0,
    childCount: 0,
    doneCount: 0,
    ...p,
  };
}

const NO_EPICS = new Map<string, BoardCard>();
const colony = { colonySize: 4, colonyReserve: 1, autoScout: false };

describe("what levels unlock", () => {
  it("lowers the reserve floor as the colony grows", () => {
    expect([1, 6, 7, 16, 17, 34].map(reserveFloor)).toEqual([2, 2, 1, 1, 0, 0]);
    expect([1, 7, 17].map(nextFloorLevel)).toEqual([7, 17, null]);
  });

  it("allows more scouts per ticket", () => {
    expect([1, 9, 10, 21, 22].map(maxScouts)).toEqual([2, 2, 3, 3, 4]);
  });
});

describe("effectiveColony", () => {
  it("leaves an uncapped board uncapped", () => {
    expect(effectiveColony({ colonySize: null, colonyReserve: 3, autoScout: true }, 9)).toEqual({
      colonySize: null,
      colonyReserve: 0,
      autoScout: false,
    });
  });

  it("holds the reserve to the level's floor, and below the size", () => {
    expect(effectiveColony({ colonySize: 4, colonyReserve: 0, autoScout: false }, 1).colonyReserve).toBe(2);
    expect(effectiveColony({ colonySize: 4, colonyReserve: 0, autoScout: false }, 17).colonyReserve).toBe(0);
    expect(effectiveColony({ colonySize: 2, colonyReserve: 5, autoScout: false }, 1).colonyReserve).toBe(1);
  });

  it("keeps auto-scouting off until its level", () => {
    const on = { colonySize: 4, colonyReserve: 1, autoScout: true };
    expect(effectiveColony(on, AUTO_SCOUT_LEVEL - 1).autoScout).toBe(false);
    expect(effectiveColony(on, AUTO_SCOUT_LEVEL).autoScout).toBe(true);
  });
});

describe("colonyAdmits", () => {
  it("admits anything with no cap", () => {
    expect(colonyAdmits(card({ id: "a" }), 99, { colonySize: null, colonyReserve: 0, autoScout: false }, NO_EPICS).ok).toBe(true);
  });

  it("stops routine work at the reserve", () => {
    expect(colonyAdmits(card({ id: "a" }), 2, colony, NO_EPICS).ok).toBe(true);
    const full = colonyAdmits(card({ id: "a" }), 3, colony, NO_EPICS);
    expect(full).toEqual({ ok: false, reason: expect.stringContaining("1 kept in reserve") });
  });

  it("lets bugs and tickets back from review use the reserve", () => {
    expect(colonyAdmits(card({ id: "a", workType: "bug" }), 3, colony, NO_EPICS).ok).toBe(true);
    expect(colonyAdmits(card({ id: "a", prNumber: 7 }), 3, colony, NO_EPICS).ok).toBe(true);
    expect(colonyAdmits(card({ id: "a", workType: "bug" }), 4, colony, NO_EPICS).ok).toBe(false);
  });

  it("counts a scouting ticket by its scouts", () => {
    expect(slotsInUse([card({ id: "a", status: "running", scouts: 3 }), card({ id: "b", status: "running" })])).toBe(4);
    expect(colonyAdmits(card({ id: "a", scouts: 3 }), 1, colony, NO_EPICS).ok).toBe(false);
  });

  it("starts a ticket bigger than the room when nothing else runs", () => {
    expect(colonyAdmits(card({ id: "a", scouts: 4 }), 0, colony, NO_EPICS).ok).toBe(true);
  });
});
