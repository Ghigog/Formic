import { describe, expect, it } from "vitest";
import { ESTABLISHED_COMMITS, SENTINELS, isEstablished, isUnlocked } from "./roster";

describe("isUnlocked", () => {
  const s = SENTINELS.find((x) => x.unlockLevel === 6)!;

  it("follows the colony level", () => {
    expect(isUnlocked(s, 5, false)).toBe(false);
    expect(isUnlocked(s, 6, false)).toBe(true);
  });

  it("opens every Sentinel when the project unlocked them all", () => {
    for (const x of SENTINELS) expect(isUnlocked(x, 1, true)).toBe(true);
  });
});

describe("isEstablished", () => {
  it("is met from 100 base-branch commits", () => {
    expect(ESTABLISHED_COMMITS).toBe(100);
    expect(isEstablished(99)).toBe(false);
    expect(isEstablished(100)).toBe(true);
    expect(isEstablished(150)).toBe(true);
  });
});
