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
  /** The column that scrolls it, and where in that column it sat. */
  box: HTMLElement | null;
  dx: number;
  dy: number;
  /** Where it was, for when its column is gone. */
  rect: DOMRect;
}

/** The epic's whole group: its header card and any tickets folded under it. */
export function groupOf(el: Element | null): HTMLElement | null {
  return (el?.closest("li") as HTMLElement | null) ?? (el as HTMLElement | null);
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") return p;
  }
  return null;
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
  const rect = el.getBoundingClientRect();
  const box = scrollerOf(el);
  const b = box?.getBoundingClientRect();
  return {
    node,
    box,
    dx: b ? rect.left - b.left + box!.scrollLeft : 0,
    dy: b ? rect.top - b.top + box!.scrollTop : 0,
    rect,
  };
}

/** Where the ghost's card would be now, its column scrolled as it is now. */
export function ghostRect(g: Ghost): DOMRect {
  if (!g.box?.isConnected) return g.rect;
  const b = g.box.getBoundingClientRect();
  return new DOMRect(b.left - g.box.scrollLeft + g.dx, b.top - g.box.scrollTop + g.dy, g.rect.width, g.rect.height);
}

export interface FlightHooks {
  /**
   * Holds the flight on the ground until `go` is called: the browser plays
   * no sound before the page's first gesture, and the flight is half sound.
   */
  hold?: (go: () => void) => void;
  /** Through the shake; t runs 0 to 1. */
  onShake?: (t: number) => void;
  onLift?: () => void;
  onHover?: () => void;
  onLaunch?: () => void;
  onSlam?: (x: number, y: number) => void;
  onWiggle?: () => void;
}

const SHAKE_MS = 1000;
const SHAKE_BEATS = 12;
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

function place(node: HTMLElement, r: DOMRect) {
  node.style.left = `${r.left}px`;
  node.style.top = `${r.top}px`;
}

/** Until the page has had a gesture: glowing where it sat, asking for one. */
async function onTheGround(ghost: Ghost, hold: NonNullable<FlightHooks["hold"]>): Promise<void> {
  const node = ghost.node;
  node.style.zIndex = "40";
  const hint = document.createElement("span");
  hint.textContent = "Complete · click anywhere";
  Object.assign(hint.style, {
    position: "absolute",
    top: "-10px",
    right: "10px",
    padding: "2px 8px",
    borderRadius: "999px",
    background: "var(--jade)",
    color: "white",
    font: "600 10px/1.4 var(--font-mono, monospace)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  });
  node.style.overflow = "visible";
  node.appendChild(hint);
  const glow = node.animate(
    [
      { boxShadow: "0 0 0 0 color-mix(in srgb, var(--jade) 45%, transparent)" },
      { boxShadow: "0 0 0 10px color-mix(in srgb, var(--jade) 0%, transparent)" },
    ],
    { duration: 1300, iterations: Infinity, easing: "ease-out" },
  );
  const itch = node.animate(
    [
      { transform: "none" },
      { transform: "rotate(-0.8deg)", offset: 0.1 },
      { transform: "rotate(0.8deg)", offset: 0.2 },
      { transform: "none", offset: 0.3 },
    ],
    { duration: 1800, iterations: Infinity },
  );
  let frame = 0;
  const follow = () => {
    place(node, ghostRect(ghost));
    frame = requestAnimationFrame(follow);
  };
  frame = requestAnimationFrame(follow);
  await new Promise<void>((go) => hold(go));
  cancelAnimationFrame(frame);
  glow.cancel();
  itch.cancel();
  hint.remove();
  node.style.overflow = "";
  node.style.zIndex = "75";
}

export async function flyHome(ghost: Ghost, home: HTMLElement, hooks: FlightHooks): Promise<void> {
  const node = ghost.node;
  const from = ghostRect(ghost);
  Object.assign(node.style, {
    position: "fixed",
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
    zIndex: "75",
    pointerEvents: "none",
    transformOrigin: "50% 100%",
    listStyle: "none",
  });
  place(node, from);
  document.body.appendChild(node);

  try {
    if (hooks.hold) await onTheGround(ghost, hooks.hold);

    home.scrollIntoView({ block: "nearest", inline: "nearest" });
    const start = ghostRect(ghost);
    place(node, start);
    const to = home.getBoundingClientRect();
    const dx = to.left - start.left;
    const dy = to.top - start.top;

    let beat = 0;
    const beats = setInterval(() => {
      beat++;
      hooks.onShake?.(Math.min(1, beat / SHAKE_BEATS));
    }, SHAKE_MS / SHAKE_BEATS);
    hooks.onShake?.(0);
    await wait(node.animate(shakeFrames(), { duration: SHAKE_MS, easing: "linear" }));
    clearInterval(beats);

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

    hooks.onHover?.();
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

    hooks.onLaunch?.();
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
  hooks.onWiggle?.();
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
