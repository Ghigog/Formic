/**
 * The guide ant's voice: Banjo-Kazooie style mutters, one short, buzzy,
 * pitch-bent syllable every few letters. Synthesised with WebAudio, so there
 * is nothing to load, and silent until the page has had a gesture.
 */

let ac: AudioContext | null = null;

/** Opens (or resumes) the audio context. Call from a pointer or key handler. */
export function wakeVoice() {
  if (typeof window === "undefined") return;
  if (ac) {
    if (ac.state === "suspended") void ac.resume().catch(() => {});
    return;
  }
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    ac = new AC();
  } catch {
    ac = null;
  }
}

/** Whether this letter, `index` letters into a line, gets a syllable. */
export function speaks(ch: string | undefined, index: number): boolean {
  return !!ch && /[a-z0-9]/i.test(ch) && index % 3 === 0;
}

/**
 * The syllable for a letter: its pitch is seeded from the letter, so the same
 * word always sounds the same, and vowels sit a little higher.
 */
export function syllable(ch: string): { freq: number; bend: number } {
  const c = ch.toLowerCase();
  const code = c.charCodeAt(0);
  const vowel = "aeiou".includes(c);
  return {
    freq: (540 + ((code * 53) % 11) * 36) * (vowel ? 1.12 : 1),
    bend: code % 2 ? 1.32 : 0.76,
  };
}

export function mutter(ch: string) {
  if (!ac || ac.state !== "running") return;
  const { freq, bend } = syllable(ch);
  const t = ac.currentTime;
  const o = ac.createOscillator();
  const o2 = ac.createOscillator();
  const f = ac.createBiquadFilter();
  const g = ac.createGain();
  o.type = "square";
  o2.type = "sawtooth";
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(freq * bend, t + 0.075);
  o2.frequency.setValueAtTime(freq / 2, t);
  o2.frequency.exponentialRampToValueAtTime((freq / 2) * bend, t + 0.075);
  f.type = "bandpass";
  f.frequency.setValueAtTime(1500, t);
  f.Q.value = 0.9;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.connect(f);
  o2.connect(f);
  f.connect(g);
  g.connect(ac.destination);
  o.start(t);
  o2.start(t);
  o.stop(t + 0.1);
  o2.stop(t + 0.1);
}
