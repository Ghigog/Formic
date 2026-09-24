/**
 * The colony's sounds, synthesised with WebAudio: no files to load, and
 * nothing plays until the page has had a gesture (browsers insist).
 */

export type Sfx =
  | "pickup"
  | "hover"
  | "deny"
  | "drop"
  | "blip"
  | "ding"
  | "squash"
  | "reject"
  | "unlock"
  | "ready"
  | "green"
  | "mult"
  | "mint"
  | "bad"
  | "emerge"
  | "attach"
  | "grab"
  | "burrow"
  | "detach"
  | "enter"
  | "decay"
  | "level"
  | "scrub"
  | "stamp"
  | "epic"
  | "rumble"
  | "pop"
  | "shimmer"
  | "whoosh"
  | "slam"
  | "boing"
  | "coin"
  | "tick"
  | "tally"
  | "fill"
  | "reveal"
  | "click"
  | "fold"
  | "unfold"
  | "close";

interface ToneOpts {
  type?: OscillatorType;
  to?: number;
  gain?: number;
  attack?: number;
  delay?: number;
}

interface NoiseOpts {
  hp?: boolean;
  freq?: number;
  to?: number;
  q?: number;
  gain?: number;
  delay?: number;
}

export class SoundEngine {
  private enabled = true;
  private gestured = false;
  private ac: AudioContext | null = null;
  private out: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private waiting: Array<() => void> = [];
  private readonly onGesture = () => {
    this.gestured = true;
    this.release();
  };

  /** Whatever was waiting to be heard goes now, after the current handlers. */
  private release() {
    const run = this.waiting;
    this.waiting = [];
    if (run.length) setTimeout(() => run.forEach((f) => f()), 0);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.release();
  }

  /** Whether the page may make sound yet: some gesture has happened on it. */
  private unlocked(): boolean {
    if (!this.gestured && navigator.userActivation?.hasBeenActive) this.gestured = true;
    return this.gestured;
  }

  /**
   * Runs `f` once sound can be heard: now, or at the page's first gesture.
   * With sound off it runs now, since nothing is waiting to be heard.
   */
  whenAudible(f: () => void): void {
    if (!this.enabled || this.unlocked()) f();
    else this.waiting.push(f);
  }

  /** Whether a celebration now would be silent for want of a gesture. */
  get muted(): boolean {
    return this.enabled && !this.unlocked();
  }

  attach(): () => void {
    window.addEventListener("pointerdown", this.onGesture, true);
    window.addEventListener("keydown", this.onGesture, true);
    return () => {
      window.removeEventListener("pointerdown", this.onGesture, true);
      window.removeEventListener("keydown", this.onGesture, true);
      void this.ac?.close().catch(() => {});
      this.ac = null;
    };
  }

  private audio(): AudioContext | null {
    if (!this.enabled || !this.unlocked()) return null;
    if (!this.ac) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      try {
        this.ac = new AC();
      } catch {
        return null;
      }
      const comp = this.ac.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      this.out = this.ac.createGain();
      this.out.gain.value = 0.9;
      this.out.connect(comp);
      comp.connect(this.ac.destination);
    }
    if (this.ac.state === "suspended") void this.ac.resume().catch(() => {});
    return this.ac;
  }

  private tone(f: number, dur: number, o: ToneOpts = {}) {
    const a = this.audio();
    if (!a || !this.out) return;
    const t = a.currentTime + (o.delay ?? 0);
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.06, t + (o.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private noise(dur: number, o: NoiseOpts = {}) {
    const a = this.audio();
    if (!a || !this.out) return;
    const t = a.currentTime + (o.delay ?? 0);
    if (!this.noiseBuf) {
      const len = Math.floor(a.sampleRate * 0.5);
      this.noiseBuf = a.createBuffer(1, len, a.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = a.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = a.createBiquadFilter();
    f.type = o.hp ? "highpass" : "lowpass";
    f.frequency.setValueAtTime(o.freq ?? 2000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    f.Q.value = o.q ?? 0.8;
    const g = a.createGain();
    g.gain.setValueAtTime(o.gain ?? 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.out);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  play(n: Sfx, v = 0) {
    if (!this.enabled || !this.unlocked()) return;
    switch (n) {
      case "pickup":
        this.tone(620, 0.07, { to: 940, gain: 0.045 });
        this.noise(0.03, { freq: 5000, hp: true, gain: 0.03 });
        break;
      case "hover":
        this.tone(1500, 0.022, { gain: 0.014, type: "triangle" });
        break;
      case "deny":
        this.tone(220, 0.06, { type: "square", gain: 0.018 });
        break;
      case "drop":
        this.noise(0.05, { freq: 2600, to: 500, gain: 0.07 });
        this.tone(260, 0.12, { to: 150, type: "triangle", gain: 0.1 });
        break;
      case "blip":
        this.tone(660 * Math.pow(2, v / 12), 0.05, { type: "square", gain: 0.016 });
        break;
      case "ding":
        this.noise(0.02, { freq: 7000, hp: true, gain: 0.05 });
        this.tone(1318.5, 0.55, { gain: 0.07 });
        this.tone(1975.5, 0.45, { gain: 0.045, delay: 0.012 });
        this.tone(2637, 0.22, { gain: 0.02, delay: 0.012, type: "triangle" });
        break;
      case "squash":
        this.noise(0.14, { freq: 2200, to: 140, gain: 0.28, q: 2 });
        this.tone(170, 0.14, { to: 55, gain: 0.18 });
        this.tone(2349, 0.2, { type: "triangle", gain: 0.05, delay: 0.03 });
        this.tone(3136, 0.14, { gain: 0.03, delay: 0.05 });
        break;
      case "reject":
        this.tone(196, 0.09, { type: "square", gain: 0.035 });
        this.tone(147, 0.12, { type: "square", gain: 0.035, delay: 0.1 });
        break;
      case "unlock":
        this.tone(988, 0.16, { gain: 0.05, type: "triangle" });
        this.tone(1480, 0.28, { gain: 0.05, delay: 0.08, type: "triangle" });
        break;
      case "ready":
        this.tone(880, 0.12, { gain: 0.035 });
        this.tone(1175, 0.2, { gain: 0.035, delay: 0.07 });
        break;
      case "green":
        this.tone(1047, 0.12, { gain: 0.03, type: "triangle" });
        this.tone(1568, 0.22, { gain: 0.03, delay: 0.06, type: "triangle" });
        break;
      case "mult": {
        const b = 523 * Math.pow(2, (v * 4) / 12);
        this.tone(b, 0.18, { type: "sawtooth", gain: 0.02, to: b * 1.5 });
        break;
      }
      case "mint":
        this.tone(440, 0.1, { to: 660, gain: 0.03, type: "triangle" });
        break;
      case "bad":
        this.tone(523, 0.14, { type: "triangle", gain: 0.05 });
        this.tone(370, 0.26, { type: "triangle", gain: 0.05, delay: 0.11, to: 330 });
        this.noise(0.06, { freq: 900, gain: 0.05, delay: 0.11 });
        break;
      case "emerge": {
        const f = 880 * Math.pow(2, (v * 2) / 12);
        this.tone(f, 0.07, { to: f * 1.45, gain: 0.022, type: "triangle" });
        break;
      }
      case "attach":
        this.tone(1900 + v * 140, 0.03, { gain: 0.024, type: "triangle" });
        this.noise(0.015, { freq: 6000, hp: true, gain: 0.015 });
        break;
      case "grab":
        this.tone(1200, 0.06, { to: 1700, gain: 0.03, type: "triangle" });
        this.noise(0.02, { freq: 6000, hp: true, gain: 0.02 });
        break;
      case "burrow":
        this.noise(0.16, { freq: 800, to: 180, gain: 0.06 });
        this.tone(220, 0.1, { to: 130, gain: 0.02 });
        break;
      case "detach": {
        const f = 1700 - v * 90;
        this.tone(f, 0.05, { to: f * 0.68, gain: 0.022, type: "triangle" });
        break;
      }
      case "enter": {
        const f = 1050 * Math.pow(2, -v / 12);
        this.tone(f, 0.09, { to: f * 0.6, gain: 0.024 });
        break;
      }
      case "decay":
        this.tone(700, 0.12, { to: 520, gain: 0.02, type: "triangle" });
        break;
      case "level":
        [523, 659, 784, 1047, 1319].forEach((f, i) =>
          this.tone(f, 0.3, { type: "triangle", gain: 0.05, delay: i * 0.07 }),
        );
        break;
      case "scrub":
        this.tone(520 * Math.pow(2, v / 24), 0.03, { type: "triangle", gain: 0.016 });
        break;
      case "stamp":
        this.noise(0.08, { freq: 1400, to: 200, gain: 0.16 });
        this.tone(150, 0.14, { to: 70, gain: 0.14 });
        this.tone(1568, 0.18, { type: "triangle", gain: 0.03, delay: 0.04 });
        break;
      case "epic":
        [392, 523, 659, 784, 1047].forEach((f, i) =>
          this.tone(f, 0.5, { type: "triangle", gain: 0.05, delay: i * 0.09 }),
        );
        setTimeout(() => this.play("ding"), 520);
        break;
      case "rumble": {
        // v: 0 to 1, how far into the shake. Louder, lower and busier.
        this.noise(0.06 + v * 0.05, { freq: 900 - v * 500, gain: 0.03 + v * 0.11, q: 1.4 });
        this.tone(95 - v * 30, 0.07, { type: "triangle", gain: 0.02 + v * 0.07 });
        if (v > 0.5) this.tone(2600 + v * 900, 0.02, { type: "square", gain: 0.006 + v * 0.01 });
        break;
      }
      case "pop":
        this.noise(0.03, { freq: 5000, hp: true, gain: 0.08 });
        this.tone(420, 0.12, { to: 1400, gain: 0.08, type: "triangle" });
        this.tone(1760, 0.16, { gain: 0.03, delay: 0.05 });
        break;
      case "shimmer":
        [2093, 2637, 3136, 2637].forEach((f, i) =>
          this.tone(f, 0.12, { type: "triangle", gain: 0.012, delay: i * 0.045 }),
        );
        break;
      case "whoosh":
        this.noise(0.5, { freq: 400, to: 3800, gain: 0.12, q: 1.8 });
        this.noise(0.5, { freq: 6000, hp: true, gain: 0.03 });
        this.tone(180, 0.5, { to: 520, gain: 0.02, type: "sawtooth" });
        break;
      case "slam":
        this.noise(0.28, { freq: 1600, to: 90, gain: 0.34, q: 1.2 });
        this.tone(120, 0.34, { to: 38, gain: 0.26 });
        this.tone(62, 0.4, { gain: 0.14, type: "triangle", delay: 0.01 });
        this.noise(0.09, { freq: 4200, hp: true, gain: 0.05, delay: 0.05 });
        this.tone(1760, 0.3, { type: "triangle", gain: 0.03, delay: 0.08 });
        break;
      case "boing":
        [740, 587, 698, 622, 659].forEach((f, i) =>
          this.tone(f, 0.09, { type: "triangle", gain: 0.045 - i * 0.007, delay: i * 0.09 }),
        );
        break;
      case "coin":
        for (let i = 0; i < 9; i++) {
          const at = 0.7 * (1 - Math.pow(1 - i / 9, 1.8));
          this.tone(2200 + i * 110, 0.025, { type: "square", gain: 0.012, delay: at });
        }
        this.tone(1568, 0.5, { gain: 0.05, delay: 0.76 });
        this.tone(2349, 0.4, { gain: 0.03, delay: 0.78 });
        break;
      case "tick": {
        // v: 0 to 1, how far the counter has climbed.
        const f = 660 * Math.pow(2, (v * 14) / 12);
        this.tone(f, 0.035, { type: "square", gain: 0.014 });
        break;
      }
      case "tally":
        this.noise(0.02, { freq: 7000, hp: true, gain: 0.05 });
        [1047, 1319, 1568, 2093].forEach((f, i) =>
          this.tone(f, 0.35, { type: "triangle", gain: 0.04, delay: i * 0.05 }),
        );
        break;
      case "fill":
        this.tone(330, 0.7, { to: 990, gain: 0.03, type: "triangle", attack: 0.08 });
        this.noise(0.6, { freq: 1200, to: 5000, gain: 0.015 });
        break;
      case "reveal":
        this.tone(784, 0.18, { gain: 0.035, type: "triangle" });
        this.tone(1175, 0.3, { gain: 0.035, delay: 0.08, type: "triangle" });
        this.tone(1568, 0.36, { gain: 0.02, delay: 0.16 });
        break;
      case "click":
        this.tone(1800, 0.018, { type: "square", gain: 0.02 });
        this.noise(0.012, { freq: 6000, hp: true, gain: 0.02 });
        break;
      case "fold":
        this.tone(900, 0.09, { to: 520, gain: 0.03, type: "triangle" });
        this.noise(0.07, { freq: 3000, to: 900, gain: 0.02 });
        break;
      case "unfold":
        this.tone(520, 0.09, { to: 900, gain: 0.03, type: "triangle" });
        this.noise(0.07, { freq: 900, to: 3000, gain: 0.02 });
        break;
      case "close":
        this.tone(880, 0.12, { to: 440, gain: 0.03, type: "triangle" });
        break;
    }
  }
}
