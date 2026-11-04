import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserEngine,
  FakeEngine,
  TURN_END_MS,
  type Recognition,
  type RecognitionEvent,
  type SpeechWindow,
} from "./engine";

class FakeRecognition implements Recognition {
  static all: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: RecognitionEvent) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.all.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  hear(text: string, isFinal = false, index = 0) {
    const results = [];
    results[index] = { isFinal, 0: { transcript: text } };
    this.onresult?.({ resultIndex: index, results });
  }
}

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = "";
  constructor(public text: string) {}
}

function setup() {
  FakeRecognition.all = [];
  const spoken: FakeUtterance[] = [];
  const cancel = vi.fn();
  const win: SpeechWindow = {
    webkitSpeechRecognition: FakeRecognition,
    SpeechSynthesisUtterance: FakeUtterance,
    speechSynthesis: { speak: (u) => spoken.push(u as FakeUtterance), cancel },
    document: { documentElement: { lang: "en" } },
  };
  const sfx = vi.fn();
  const engine = createBrowserEngine({ sfx, win });
  const turns: string[] = [];
  engine.onTurn((t) => turns.push(t));
  const rec = () => FakeRecognition.all[FakeRecognition.all.length - 1]!;
  return { engine, turns, spoken, cancel, sfx, rec };
}

describe("browser call engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is unsupported without SpeechRecognition", () => {
    expect(createBrowserEngine({ sfx: vi.fn(), win: {} }).supported).toBe(false);
  });

  it("listens continuously with interim results and primes synthesis", () => {
    const { engine, rec, spoken, sfx } = setup();
    expect(engine.supported).toBe(true);
    engine.start();
    expect(rec().continuous).toBe(true);
    expect(rec().interimResults).toBe(true);
    expect(rec().started).toBe(true);
    expect(spoken.map((u) => u.text)).toEqual([""]);
    expect(sfx).toHaveBeenCalledWith("unlock");
  });

  it("emits one turn with the whole utterance after the pause", () => {
    const { engine, turns, rec } = setup();
    engine.start();
    rec().hear("hello", false, 0);
    vi.advanceTimersByTime(TURN_END_MS - 100);
    rec().hear("hello there", true, 0);
    vi.advanceTimersByTime(TURN_END_MS - 100);
    expect(turns).toEqual([]);
    rec().hear("how are you", false, 1);
    vi.advanceTimersByTime(TURN_END_MS);
    expect(turns).toEqual(["hello there how are you"]);
  });

  it("barge-in cancels speech and the words become the next turn", async () => {
    const { engine, turns, rec, cancel } = setup();
    engine.start();
    const done = engine.speak("The build is green and ready");
    rec().hear("wait stop", false, 0);
    await done;
    expect(cancel).toHaveBeenCalled();
    vi.advanceTimersByTime(TURN_END_MS);
    expect(turns).toEqual(["wait stop"]);
  });

  it("ignores recognised text that matches what is being spoken", () => {
    const { engine, turns, rec, cancel } = setup();
    engine.start();
    void engine.speak("The build is green");
    rec().hear("the build is", false, 0);
    vi.advanceTimersByTime(TURN_END_MS * 2);
    expect(turns).toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1); // only speak()'s own reset
  });

  it("restarts recognition when the browser ends the session", () => {
    const { engine, rec } = setup();
    engine.start();
    const first = rec();
    first.onend?.();
    expect(FakeRecognition.all).toHaveLength(2);
    expect(rec().started).toBe(true);
    engine.stop();
    rec().onend?.();
    expect(FakeRecognition.all).toHaveLength(2);
  });

  it("emits no turn while muted and listens again after unmute", () => {
    const { engine, turns, rec } = setup();
    engine.start();
    engine.mute(true);
    expect(rec().started).toBe(false);
    rec().hear("secret", true, 0);
    vi.advanceTimersByTime(TURN_END_MS * 2);
    expect(turns).toEqual([]);
    engine.mute(false);
    expect(rec().started).toBe(true);
    rec().hear("hi", true, 0);
    vi.advanceTimersByTime(TURN_END_MS);
    expect(turns).toEqual(["hi"]);
  });
});

describe("FakeEngine", () => {
  it("emits turns only while live and unmuted", () => {
    const e = new FakeEngine();
    const turns: string[] = [];
    e.onTurn((t) => turns.push(t));
    e.say("ignored");
    e.start();
    e.say("one");
    e.mute(true);
    e.say("two");
    expect(turns).toEqual(["one"]);
  });
});
