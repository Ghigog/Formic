import type { Sfx } from "@/components/colony/sound";

/** Silence after the last recognition result that ends the person's turn. */
export const TURN_END_MS = 1200;

export type CallCue = "joined" | "yourTurn" | "thinking" | "left";

/** Cues reuse existing sounds; the call adds none of its own. */
export const CALL_CUE_SFX: Record<CallCue, Sfx> = {
  joined: "unlock",
  yourTurn: "blip",
  thinking: "tick",
  left: "close",
};

/** Speech in and out for a call, whatever provides it. */
export interface CallEngine {
  /** False where the browser cannot recognise speech (Firefox). */
  readonly supported: boolean;
  /** Joins the call. Call it from the tap: iOS only speaks after a gesture. */
  start(): void;
  stop(): void;
  mute(muted: boolean): void;
  /** Reads text aloud; resolves when finished or cancelled. */
  speak(text: string): Promise<void>;
  cancelSpeech(): void;
  /** One call per finished turn, with the whole utterance. */
  onTurn(handler: (text: string) => void): () => void;
  /** The person started talking (also fires when they talk over a reply). */
  onSpeechStart(handler: () => void): () => void;
}

/* The slice of the Web Speech API the adapter uses. */
interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
export interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
export interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface Utterance {
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
export interface SpeechWindow {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
  SpeechSynthesisUtterance?: new (text: string) => Utterance;
  speechSynthesis?: {
    speak(u: Utterance): void;
    cancel(): void;
  };
  document?: { documentElement: { lang: string } };
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export function createBrowserEngine(opts: {
  sfx: (n: Sfx) => void;
  win?: SpeechWindow;
}): CallEngine {
  const win: SpeechWindow | undefined =
    opts.win ??
    (typeof window === "undefined"
      ? undefined
      : (window as unknown as SpeechWindow));
  const Ctor = win?.SpeechRecognition ?? win?.webkitSpeechRecognition;
  const turnHandlers = new Set<(t: string) => void>();
  const startHandlers = new Set<() => void>();
  const cue = (c: CallCue) => opts.sfx(CALL_CUE_SFX[c]);

  let live = false;
  let muted = false;
  let recognition: Recognition | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let committed = "";
  let interim = "";
  let skipBelow = 0;
  let spoken: string | null = null;
  let finishSpeech: (() => void) | null = null;
  let talking = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const resetUtterance = () => {
    clearTimer();
    committed = "";
    interim = "";
    talking = false;
  };

  const cancelSpeech = () => {
    win?.speechSynthesis?.cancel();
    spoken = null;
    const done = finishSpeech;
    finishSpeech = null;
    done?.();
  };

  const endTurn = () => {
    timer = null;
    const text = `${committed} ${interim}`.replace(/\s+/g, " ").trim();
    resetUtterance();
    if (!text) return;
    cue("thinking");
    for (const h of [...turnHandlers]) h(text);
  };

  const onResult = (e: RecognitionEvent) => {
    if (!live || muted) return;
    let finals = "";
    let pending = "";
    for (let i = Math.max(e.resultIndex, skipBelow); i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) finals += ` ${r[0].transcript}`;
      else pending += ` ${r[0].transcript}`;
    }
    const heard = `${finals} ${pending}`.trim();
    if (!heard) return;
    // The mic hears the speaker: our own voice is not the person talking.
    if (spoken !== null && normalize(spoken).includes(normalize(heard))) return;
    if (spoken !== null) cancelSpeech(); // barge-in
    if (!talking) {
      talking = true;
      for (const h of [...startHandlers]) h();
    }
    committed = `${committed} ${finals}`.trim();
    interim = pending.trim();
    clearTimer();
    timer = setTimeout(() => {
      skipBelow = e.results.length;
      endTurn();
    }, TURN_END_MS);
  };

  const listen = () => {
    if (!Ctor || recognition) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = win?.document?.documentElement.lang ?? "";
    r.onresult = onResult;
    r.onend = () => {
      if (recognition !== r) return;
      recognition = null;
      skipBelow = 0;
      // Chrome ends sessions on its own: carry on while the call is live.
      if (live && !muted) listen();
    };
    recognition = r;
    r.start();
  };

  const unlisten = () => {
    const r = recognition;
    recognition = null;
    if (r) {
      r.onresult = null;
      r.onend = null;
      r.stop();
    }
    skipBelow = 0;
    resetUtterance();
  };

  return {
    supported: Ctor !== undefined,
    start() {
      if (!Ctor || live) return;
      live = true;
      muted = false;
      // iOS Safari speaks only after a gesture: prime with an empty utterance.
      if (win?.SpeechSynthesisUtterance && win.speechSynthesis) {
        win.speechSynthesis.speak(new win.SpeechSynthesisUtterance(""));
      }
      cue("joined");
      listen();
    },
    stop() {
      if (!live) return;
      live = false;
      unlisten();
      cancelSpeech();
      cue("left");
    },
    mute(m) {
      if (muted === m) return;
      muted = m;
      if (!live) return;
      if (m) unlisten();
      else {
        listen();
        cue("yourTurn");
      }
    },
    speak(text) {
      const synth = win?.speechSynthesis;
      const Utt = win?.SpeechSynthesisUtterance;
      if (!synth || !Utt || !text.trim()) return Promise.resolve();
      cancelSpeech();
      return new Promise<void>((resolve) => {
        const u = new Utt(text);
        u.lang = win?.document?.documentElement.lang ?? "";
        const done = () => {
          if (finishSpeech === done) {
            finishSpeech = null;
            spoken = null;
            cue("yourTurn");
          }
          resolve();
        };
        finishSpeech = done;
        spoken = text;
        u.onend = done;
        u.onerror = done;
        synth.speak(u);
      });
    },
    cancelSpeech,
    onTurn(h) {
      turnHandlers.add(h);
      return () => turnHandlers.delete(h);
    },
    onSpeechStart(h) {
      startHandlers.add(h);
      return () => startHandlers.delete(h);
    },
  };
}

/** In-memory engine for tests of the code that drives a call. */
export class FakeEngine implements CallEngine {
  supported = true;
  live = false;
  muted = false;
  spoken: string[] = [];
  private turnHandlers = new Set<(t: string) => void>();
  private startHandlers = new Set<() => void>();
  private pending: (() => void) | null = null;

  start() {
    this.live = true;
  }
  stop() {
    this.live = false;
    this.cancelSpeech();
  }
  mute(m: boolean) {
    this.muted = m;
  }
  speak(text: string) {
    this.spoken.push(text);
    return new Promise<void>((resolve) => {
      this.pending = resolve;
    });
  }
  cancelSpeech() {
    this.pending?.();
    this.pending = null;
  }
  get speaking() {
    return this.pending !== null;
  }
  finishSpeech() {
    this.cancelSpeech();
  }
  onTurn(h: (t: string) => void) {
    this.turnHandlers.add(h);
    return () => this.turnHandlers.delete(h);
  }
  onSpeechStart(h: () => void) {
    this.startHandlers.add(h);
    return () => this.startHandlers.delete(h);
  }
  /** Test helper: the person says something and finishes their turn. */
  say(text: string) {
    if (!this.live || this.muted) return;
    for (const h of [...this.startHandlers]) h();
    this.cancelSpeech();
    for (const h of [...this.turnHandlers]) h(text);
  }
}
