/**
 * An epic flying home to Done: it shakes harder and harder where it sat,
 * pops out, hangs for a beat, accelerates across the board, slams down and
 * wiggles into place.
 *
 * The board moves the card the moment its status changes, so the flight is
 * flown by a copy of how it last looked where it was, over the real card,
 * which waits hidden in its new place until the copy lands on it.
 */

export interface Ghost {
  /** A detached copy of the epic's group as it last rendered. */
  node: HTMLElement;
  rect: DOMRect;
}

/** The epic's whole group: its header card and any tickets folded under it. */
export function groupOf(el: Element | null): HTMLElement | null {
  return (el?.closest("li") as HTMLElement | null) ?? (el as HTMLElement | null);
}

/** A copy of an element that nothing can find, focus or drag. */
export function ghostOf(el: HTMLElement): Ghost {
  const node = el.cloneNode(true) as HTMLElement;
  for (const n of [node, ...node.querySelectorAll<HTMLElement>("*")]) {
    for (const a of [...n.attributes]) {
      if (a.name === "id" || a.name.startsWith("data-")) n.removeAttribute(a.name);
    }
  }
  node.setAttribute("aria-hidden", "true");
  node.inert = true;
  return { node, rect: el.getBoundingClientRect() };
}

const SHAKE_MS = 1000;
const POP_MS = 260;
const HOVER_MS = 200;
const FLY_MS = 520;
const SLAM_MS = 140;
const WIGGLE_MS = 560;

function shakeFrames(): Keyframe[] {
  const frames: Keyframe[] = [];
  const n = 22;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const amp = 0.4 + t * t * 5;
    const dir = i % 2 === 0 ? 1 : -1;
    frames.push({
      transform: i === n ? "none" : `translate(${dir * amp}px, ${-dir * amp * 0.35}px) rotate(${dir * amp * 0.45}deg)`,
    });
  }
  return frames;
}

function wait(anim: Animation): Promise<void> {
  return anim.finished.then(
    () => undefined,
    () => undefined,
  );
}

export async function flyHome(
  ghost: Ghost,
  home: HTMLElement,
  hooks: { onLift?: () => void; onSlam?: (x: number, y: number) => void },
): Promise<void> {
  home.scrollIntoView({ block: "nearest", inline: "nearest" });
  const from = ghost.rect;
  const to = home.getBoundingClientRect();
  const dx = to.left - from.left;
  const dy = to.top - from.top;

  const node = ghost.node;
  Object.assign(node.style, {
    position: "fixed",
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
    zIndex: "75",
    pointerEvents: "none",
    transformOrigin: "50% 100%",
    listStyle: "none",
  });
  document.body.appendChild(node);

  try {
    await wait(node.animate(shakeFrames(), { duration: SHAKE_MS, easing: "linear" }));

    hooks.onLift?.();
    const lifted = "translate(0, -22px) scale(1.1)";
    const shadow = "0 34px 60px -20px color-mix(in srgb, var(--anthracite) 55%, transparent)";
    await wait(
      node.animate(
        [
          { transform: "none", boxShadow: "0 0 0 transparent" },
          { transform: lifted, boxShadow: shadow },
        ],
        { duration: POP_MS, easing: "cubic-bezier(.2,1.7,.4,1)", fill: "forwards" },
      ),
    );

    await wait(
      node.animate(
        [
          { transform: lifted, boxShadow: shadow },
          { transform: "translate(0, -26px) scale(1.1)", boxShadow: shadow, offset: 0.5 },
          { transform: lifted, boxShadow: shadow },
        ],
        { duration: HOVER_MS, easing: "ease-in-out", fill: "forwards" },
      ),
    );

    const tilt = Math.sign(dx) * 6;
    await wait(
      node.animate(
        [
          { transform: lifted, boxShadow: shadow },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 30}px) scale(1.06) rotate(${tilt}deg)`, boxShadow: shadow, offset: 0.55 },
          { transform: `translate(${dx}px, ${dy}px) scale(1)`, boxShadow: "0 0 0 transparent" },
        ],
        { duration: FLY_MS, easing: "cubic-bezier(.6,0,1,.6)", fill: "forwards" },
      ),
    );
  } finally {
    node.remove();
  }

  home.style.visibility = "";
  const land = home.getBoundingClientRect();
  hooks.onSlam?.(land.left + land.width / 2, land.bottom);

  home.style.transformOrigin = "50% 100%";
  await wait(
    home.animate(
      [
        { transform: "scale(1.09, 0.86)" },
        { transform: "scale(0.97, 1.04)" },
        { transform: "none" },
      ],
      { duration: SLAM_MS * 2, easing: "ease-out" },
    ),
  );
  home.style.transformOrigin = "50% 50%";
  const list = home.lastElementChild !== home.firstElementChild ? home.lastElementChild : null;
  list?.animate(
    [
      { opacity: 0, transform: "translateY(-8px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 360, easing: "ease-out" },
  );
  await wait(
    home.animate(
      [
        { transform: "none" },
        { transform: "rotate(-2.6deg)" },
        { transform: "rotate(2deg)" },
        { transform: "rotate(-1.3deg)" },
        { transform: "rotate(0.7deg)" },
        { transform: "none" },
      ],
      { duration: WIGGLE_MS, easing: "ease-out" },
    ),
  );
  home.style.transformOrigin = "";
}
