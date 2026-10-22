import { afterEach, describe, expect, it, vi } from "vitest";
import { SoundEngine, type Sfx } from "./sound";

const SFX: Sfx[] = [
  "pickup",
  "hover",
  "deny",
  "drop",
  "blip",
  "ding",
  "squash",
  "reject",
  "unlock",
  "ready",
  "green",
  "mult",
  "mint",
  "bad",
  "emerge",
  "attach",
  "grab",
  "burrow",
  "detach",
  "enter",
  "decay",
  "level",
  "scrub",
  "stamp",
  "epic",
  "rumble",
  "pop",
  "shimmer",
  "whoosh",
  "slam",
  "boing",
  "coin",
  "tick",
  "tally",
  "fill",
  "reveal",
  "click",
  "fold",
  "unfold",
  "close",
  "crumble",
  "sentinelLand",
  "sentinelVoice",
];

function fakeContext(state: string) {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const node = () => ({
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    frequency: param(),
    gain: param(),
    Q: param(),
  });
  return class {
    static made = 0;
    state = state;
    currentTime = 0;
    sampleRate = 100;
    destination = {};
    constructor() {
      (this.constructor as unknown as { made: number }).made++;
    }
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
    createDynamicsCompressor = () => ({
      ...node(),
      threshold: param(),
      ratio: param(),
    });
    createGain = node;
    createOscillator = node;
    createBiquadFilter = node;
    createBufferSource = node;
    createBuffer = () => ({ getChannelData: () => new Float32Array(50) });
  };
}

function useContext(AC: ReturnType<typeof fakeContext>) {
  Object.defineProperty(window, "AudioContext", {
    value: AC,
    configurable: true,
  });
}

describe("SoundEngine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays every sound once a gesture has happened", () => {
    vi.useFakeTimers();
    const AC = fakeContext("running");
    useContext(AC);
    const e = new SoundEngine();
    const detach = e.attach();
    window.dispatchEvent(new Event("pointerdown"));
    for (const s of SFX) {
      e.play(s, 0);
      e.play(s, 0.8);
    }
    e.play("sentinelVoice", 99);
    vi.advanceTimersByTime(1000);
    detach();
    expect(AC.made).toBe(1);
  });

  it("stays silent before a gesture and when disabled, and runs waiting work on the gesture", () => {
    vi.useFakeTimers();
    const AC = fakeContext("suspended");
    useContext(AC);
    const e = new SoundEngine();
    const detach = e.attach();
    expect(e.muted).toBe(true);
    e.play("click");
    expect(AC.made).toBe(0);
    const f = vi.fn();
    e.whenAudible(f);
    expect(f).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(10);
    expect(f).toHaveBeenCalledTimes(1);
    expect(e.muted).toBe(false);

    // Still suspended after the ask to resume: the context is rebuilt.
    document.dispatchEvent(new Event("visibilitychange"));
    e.play("click");
    expect(AC.made).toBeGreaterThan(1);

    e.setEnabled(false);
    const before = AC.made;
    const g = vi.fn();
    e.whenAudible(g);
    expect(g).toHaveBeenCalled();
    e.play("click");
    expect(AC.made).toBe(before);
    detach();
  });

  it("falls back to webkitAudioContext, and stays silent with none or when it cannot be built", () => {
    const gesture = (e: SoundEngine) => {
      const detach = e.attach();
      window.dispatchEvent(new Event("pointerdown"));
      return detach;
    };
    const w = window as unknown as Record<string, unknown>;

    const Webkit = fakeContext("interrupted");
    Object.defineProperty(window, "AudioContext", {
      value: undefined,
      configurable: true,
    });
    w.webkitAudioContext = Webkit;
    const a = new SoundEngine();
    const detachA = gesture(a);
    a.play("click");
    a.play("click");
    expect(Webkit.made).toBeGreaterThan(0);
    detachA();

    delete w.webkitAudioContext;
    const b = new SoundEngine();
    const detachB = gesture(b);
    expect(() => b.play("click")).not.toThrow();
    detachB();

    Object.defineProperty(window, "AudioContext", {
      value: class {
        constructor() {
          throw new Error("no audio");
        }
      },
      configurable: true,
    });
    const c = new SoundEngine();
    const detachC = gesture(c);
    expect(() => c.play("click")).not.toThrow();
    detachC();
  });
});
