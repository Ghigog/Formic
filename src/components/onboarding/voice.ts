import { SoundEngine } from "@/components/colony/sound";

/**
 * The guide ant's voice: Banjo-Kazooie style mutters, one short, buzzy,
 * pitch-bent syllable every few letters.
 *
 * It plays through the colony's SoundEngine, which already knows how to get
 * a browser to make sound: open the audio inside the page's first gesture,
 * and bring it back when WebKit parks it (the desktop app is WebKit). Its
 * own engine rather than the board's, because tours also run where there is
 * no board: sign-in, the picker, Settings.
 */

let engine: SoundEngine | null = null;

/** Starts listening for the gesture that lets the page make sound. Returns the undo. */
export function attachVoice(): () => void {
  engine ??= new SoundEngine();
  return engine.attach();
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
  const { freq, bend } = syllable(ch);
  engine?.syllable(freq, bend);
}
