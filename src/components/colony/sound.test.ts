import { readFileSync } from "node:fs";
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

describe("DESIGN.md Sound section", () => {
  it("names every Sfx cue", () => {
    const brief = readFileSync("design/DESIGN.md", "utf8");
    const section = brief.split(/^## Sound$/m)[1]!.split(/^## /m)[0]!;
    const src = readFileSync("src/components/colony/sound.ts", "utf8");
    const union = src.slice(src.indexOf("export type Sfx"), src.indexOf(";", src.indexOf("export type Sfx")));
    const cues = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
    expect(cues.length).toBeGreaterThan(50);
    for (const cue of cues) expect(section, cue).toMatch(new RegExp(`\\b${cue}\\b`));
  });
});
