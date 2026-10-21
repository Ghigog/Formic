import { describe, expect, it, vi } from "vitest";
import { SENTINELS } from "@/lib/sentinels/roster";
import { SENTINEL_VOICES, SoundEngine } from "./sound";

describe("SENTINEL_VOICES", () => {
  it("gives every sentinel a voice of its own", () => {
    for (const x of SENTINELS) expect(SENTINEL_VOICES[x.id]).toBeDefined();
    const keys = SENTINELS.map((x) => JSON.stringify(SENTINEL_VOICES[x.id]));
    expect(new Set(keys).size).toBe(SENTINELS.length);
  });
});

describe("SoundEngine skitter and hiss", () => {
  it("play without throwing, and stay silent when disabled", () => {
    const engine = new SoundEngine();
    expect(() => {
      engine.play("skitter");
      engine.play("hiss");
    }).not.toThrow();
    engine.setEnabled(false);
    const ac = vi.fn();
    vi.stubGlobal("AudioContext", ac);
    engine.play("skitter");
    engine.play("hiss");
    expect(ac).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
