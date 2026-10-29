import { describe, expect, it } from "vitest";
import { SENTINELS } from "@/lib/sentinels/roster";
import { isGuestId } from "./guests";

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
