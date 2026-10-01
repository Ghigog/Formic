/**
 * An archived ticket crumbling into the nest: a copy of the card (see
 * ghostOf) splits into a grid of clipped fragments that jitter, fall and
 * turn, then shrink away toward the nest, where they are buried.
 *
 * The flight starts over the real card in the same frame that the board
 * removes it, so the card never flashes between the two.
 */
import { ghostRect, type Ghost } from "./epic-flight";

export interface ArchiveFlightHooks {
  /** Skip the crumble: only the sound, through onCrumble. */
  reduced?: boolean;
  /** The card starts to break up. */
  onCrumble?: () => void;
  /** The last fragment reaches the nest. */
  onBury?: () => void;
}

export const CRUMBLE_COLS = 4;
export const CRUMBLE_ROWS = 3;
const CRUMBLE_MS = 420;
const CARRY_MS = 620;

function wait(anim: Animation): Promise<void> {
  return anim.finished.then(
    () => undefined,
    () => undefined,
  );
}

/** Where the nest is, or the bottom-right corner when it is not on screen. */
function nestPoint(nest: HTMLElement | null): [number, number] {
  const r = nest?.getBoundingClientRect();
  if (!r || !r.width) return [window.innerWidth - 30, window.innerHeight - 28];
  return [r.left + r.width / 2, r.top + r.height / 2];
}

export async function flyToNest(ghost: Ghost, nest: HTMLElement | null, hooks: ArchiveFlightHooks = {}): Promise<void> {
  hooks.onCrumble?.();
  if (hooks.reduced) return;

  const from = ghostRect(ghost);
  const [nx, ny] = nestPoint(nest);
  const cw = from.width / CRUMBLE_COLS;
  const ch = from.height / CRUMBLE_ROWS;
  const pieces: HTMLElement[] = [];

  try {
    for (let r = 0; r < CRUMBLE_ROWS; r++) {
      for (let c = 0; c < CRUMBLE_COLS; c++) {
        const piece = ghost.node.cloneNode(true) as HTMLElement;
        Object.assign(piece.style, {
          position: "fixed",
          left: `${from.left}px`,
          top: `${from.top}px`,
          width: `${from.width}px`,
          height: `${from.height}px`,
          margin: "0",
          transform: "none",
          zIndex: "75",
          pointerEvents: "none",
          listStyle: "none",
          clipPath: `inset(${r * ch}px ${from.width - (c + 1) * cw}px ${from.height - (r + 1) * ch}px ${c * cw}px)`,
        });
        document.body.appendChild(piece);
        pieces.push(piece);
      }
    }

    const done = pieces.map(async (piece, i) => {
      const c = i % CRUMBLE_COLS;
      const r = Math.floor(i / CRUMBLE_COLS);
      // Pieces' centres relative to the card's centre, and where they end up.
      const px = (c + 0.5) * cw - from.width / 2;
      const py = (r + 0.5) * ch - from.height / 2;
      const jx = (Math.random() - 0.5) * 14;
      const jy = (Math.random() - 0.5) * 14;
      const spin = (Math.random() - 0.5) * 70;
      const fall = 30 + Math.random() * 50;
      const toNest = `translate(${nx - from.left - from.width / 2 - px}px, ${ny - from.top - from.height / 2 - py}px)`;
      // Each piece turns about its own centre.
      piece.style.transformOrigin = `${(c + 0.5) * cw}px ${(r + 0.5) * ch}px`;
      const apart = `translate(${px * 0.25 + jx}px, ${py * 0.25 + jy + fall}px) rotate(${spin}deg)`;
      await wait(
        piece.animate(
          [
            { transform: "none" },
            { transform: `translate(${jx}px, ${jy}px) rotate(${spin / 4}deg)`, offset: 0.3 },
            { transform: apart },
          ],
          { duration: CRUMBLE_MS, easing: "ease-in", fill: "forwards" },
        ),
      );
      await wait(
        piece.animate(
          [
            { transform: apart, opacity: 1 },
            { transform: `${toNest} rotate(${spin * 2}deg) scale(0.1)`, opacity: 0.2 },
          ],
          { duration: CARRY_MS, delay: i * 18, easing: "cubic-bezier(.5,0,.9,.5)", fill: "forwards" },
        ),
      );
    });
    await Promise.all(done);
    hooks.onBury?.();
  } finally {
    for (const p of pieces) p.remove();
  }
}
