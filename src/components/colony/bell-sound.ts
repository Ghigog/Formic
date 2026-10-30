/**
 * The bell's voice, synthesised: a struck bell is a handful of inharmonic
 * partials that each fade at their own rate, the high ones first. No audio
 * file to load, and it only ever plays in answer to the person's own hand,
 * which is when browsers allow sound.
 */

/** A small silver hand bell: partials as ratios of the strike tone, with their loudness and how long they ring. */
const PARTIALS: ReadonlyArray<{ ratio: number; gain: number; decay: number }> = [
  { ratio: 0.5, gain: 0.35, decay: 2.4 },
  { ratio: 1, gain: 0.6, decay: 1.8 },
  { ratio: 1.183, gain: 0.3, decay: 1.4 },
  { ratio: 1.506, gain: 0.22, decay: 1.1 },
  { ratio: 2, gain: 0.18, decay: 0.9 },
  { ratio: 2.514, gain: 0.12, decay: 0.6 },
  { ratio: 3.011, gain: 0.08, decay: 0.4 },
];

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context ??= new Ctor();
    if (context.state === "suspended") void context.resume();
    return context;
  } catch {
    return null;
  }
}

/** Wakes the audio on the press that may ring, so the first strike is not late. */
export function primeBell(): void {
  audio();
}

/** Strikes the bell. `strength` 0 to 1: a full swing rings out, a follow-up swing is softer. */
export function strikeBell(strength = 1, strikeHz = 1318.5): void {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.22 * Math.max(0.15, Math.min(1, strength));
  out.connect(ctx.destination);
  for (const p of PARTIALS) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = strikeHz * p.ratio;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(p.gain, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);
    osc.connect(gain).connect(out);
    osc.start(now);
    osc.stop(now + p.decay + 0.05);
  }
}
