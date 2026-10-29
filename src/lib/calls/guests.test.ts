import { describe, expect, it } from "vitest";
import { SENTINELS } from "@/lib/sentinels/roster";
import { guestOptions, isGuestId } from "./guests";

describe("isGuestId", () => {
  it("accepts the assistant, every column agent and every Sentinel", () => {
    for (const id of ["assistant", "product", "architect", "coder", "reviewer", "pm"]) {
      expect(isGuestId(id)).toBe(true);
    }
    for (const s of SENTINELS) expect(isGuestId(`sentinel:${s.id}`)).toBe(true);
  });

  it("rejects anything else", () => {
    for (const id of ["", "Assistant", "sentinel:", "sentinel:nobody", "tester", "ceo", 7, null]) {
      expect(isGuestId(id)).toBe(false);
    }
  });
});

describe("guestOptions", () => {
  it("offers only the Sentinels the colony has unlocked", () => {
    const first = SENTINELS.reduce((a, b) => (b.unlockLevel < a.unlockLevel ? b : a));
    const ids = (level: number) => guestOptions(level).map((g) => g.id);
    expect(ids(0).some((id) => id.startsWith("sentinel:"))).toBe(false);
    expect(ids(first.unlockLevel)).toContain(`sentinel:${first.id}`);
    expect(ids(first.unlockLevel)).toContain("assistant");
    const locked = SENTINELS.find((s) => s.unlockLevel > first.unlockLevel)!;
    expect(ids(first.unlockLevel)).not.toContain(`sentinel:${locked.id}`);
  });
});
