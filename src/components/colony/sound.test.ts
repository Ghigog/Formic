import { describe, expect, it } from "vitest";
import { SENTINELS } from "@/lib/sentinels/roster";
import { SENTINEL_VOICES } from "./sound";

describe("SENTINEL_VOICES", () => {
  it("gives every sentinel a voice of its own", () => {
    for (const x of SENTINELS) expect(SENTINEL_VOICES[x.id]).toBeDefined();
    const keys = SENTINELS.map((x) => JSON.stringify(SENTINEL_VOICES[x.id]));
    expect(new Set(keys).size).toBe(SENTINELS.length);
  });
});
