import { SoundEngine, type Sfx } from "@/components/colony/sound";
import { soundOn } from "@/components/colony/store";

/**
 * The board swap's sounds. They play through the colony's SoundEngine, which
 * knows how to get a browser to make sound and keep it (WebKit parks it), and
 * honour the same sound switch. Its own engine rather than the board's, as
 * the guide ant's voice has: the swap sits outside the board it swaps.
 */

let engine: SoundEngine | null = null;

/** Starts listening for the gesture that lets the page make sound. Returns the undo. */
export function attachSwapSound(): () => void {
  engine ??= new SoundEngine();
  return engine.attach();
}

export function swapSfx(name: Extract<Sfx, "dig" | "grit" | "surface" | "drop">): void {
  if (!engine) return;
  engine.setEnabled(soundOn());
  engine.play(name);
}
