import { COLOR_UNLOCKS, type BugShape } from "@/lib/colony/game";
import type { SoundEngine } from "./sound";

/**
 * The colony's canvas: one fixed, pointer-transparent layer over the board
 * that draws everything that is not a DOM element. Bursts and rings when
 * work lands, score pops, points flying to the counter, squashed bugs, and
 * the ants: a crew walks out of the nest to every running card, circles it
 * while its agent works, and tunnels through a card in review, leaving
 * trails in it.
 *
 * Cards are found by `data-tid`; a card that wants trails carries a
 * `canvas[data-trail]` of its own.
 */

/** The largest crew a card gets: 13, the top of the story point scale. */
export const MAX_CREW = 13;

/** What a card's crew should be doing. */
export type CrewPhase = "work" | "tunnel" | "buried" | "leave";

/** The part of the board the canvas draws from, pushed in as it changes. */
export interface FxWorld {
  /** Every card that should have a crew right now, and what it is worth. */
  crews: Map<string, { phase: CrewPhase; sp: number }>;
  level: number;
  ants: "busy" | "few" | "off";
  /** Full juice: big bursts and shakes. False dials it down. */
  full: boolean;
  bugShape: BugShape;
  bugHex: string;
  /** Something covers the board (the timeline): draw no ants. */
  covered: boolean;
}

/** The colony's anchor elements, marked with `data-colony`. */
export type ColonyAnchor = "board" | "score" | "level" | "heat" | "nest" | "timeline";

/** The one on screen: the wide header and the app bar each carry their own. */
export function colonyEl(name: ColonyAnchor): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-colony="${name}"]`)) {
    if (el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  max: number;
  size: number;
  color: string;
  rot: number;
  vr: number;
  shape: "oct" | "dot";
}
interface Ring {
  x: number;
  y: number;
  r1: number;
  color: string;
  life: number;
  max: number;
  w: number;
}
interface Pop {
  x: number;
  y: number;
  text: string;
  sub: string | null;
  color: string;
  size: number;
  life: number;
  max: number;
}
interface Flyer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  t: number;
  dur: number;
  delay: number;
  color: string;
  i: number;
  onEach?: (i: number) => void;
  trail: Array<[number, number]>;
}
interface Carrier {
  x: number;
  y: number;
  a: number;
  ph: number;
  wait: number;
  carry: string;
}
interface Splat {
  x: number;
  y: number;
  t: number;
  hit?: boolean;
  blobs: Array<{ dx: number; dy: number; r: number }>;
  onSquash: () => void;
}
type AntMode = "wait" | "walk" | "perim" | "dig" | "buried" | "rise" | "tunnel" | "out" | "home";
interface Ant {
  x: number;
  y: number;
  a: number;
  ph: number;
  mode: AntMode;
  wait: number;
  idx: number;
  leader: boolean;
  t: number;
  sp: number;
  lx?: number;
  ly?: number;
  h?: number;
  th?: number;
  choose?: number;
  anim?: number;
  puffed?: boolean;
  carry?: boolean;
  hidden?: boolean;
  gone?: boolean;
}
interface Crew {
  id: string;
  sp: number;
  phase: CrewPhase;
  ants: Ant[];
}
interface Trail {
  cv: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  grid: Uint8Array;
  ver: number;
}
type TrailCanvas = HTMLCanvasElement & { __v?: number; __id?: string | null };

const TAU = Math.PI * 2;

/*
 * Colours. Everything here is named by design token, as \`var(--token)\`,
 * and resolved against the page when drawn, so the canvas follows the
 * theme like the DOM does. Resolved values are cached until the theme
 * attribute changes.
 */
const resolved = new Map<string, string>();

export function css(color: string): string {
  if (!color.startsWith("var(")) return color;
  const hit = resolved.get(color);
  if (hit) return hit;
  const name = color.slice(4, -1).trim();
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#1c1917";
  resolved.set(color, value);
  return value;
}

/** A token at an alpha, for the canvas. */
export function cssAlpha(color: string, alpha: number): string {
  const hex = css(color);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
}

export function cardEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tid="${CSS.escape(id)}"]`);
}

/**
 * Whether the drag library is holding this card: dragging it, or animating
 * it into place after a drop. It moves the card with a transform transition
 * and waits for that transition to end before it calls the drop done. An
 * animation on the card's transform cancels the transition, the end never
 * comes, and the drag hangs: the card stays where it was picked up and never
 * moves. Its dragging style is the one that fixes the card to the viewport.
 */
export function heldByDrag(el: Element): boolean {
  return el.closest<HTMLElement>("[data-rfd-draggable-id]")?.style.position === "fixed";
}

export function centerOf(el: Element): [number, number, DOMRect] {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2, r];
}

/** The polygon a story-point badge draws: more points, more sides. */
export function spVerts(n: number, cx: number, cy: number, r: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  if (n <= 2) {
    const rx = n === 1 ? r * 0.75 : r;
    const ry = n === 1 ? r * 0.75 : r * 0.48;
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * TAU;
      pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
    }
  } else {
    const sides = Math.min(n, 13);
    const off = sides === 8 ? Math.PI / 8 : 0;
    for (let i = 0; i < sides; i++) {
      const t = -Math.PI / 2 + off + (i / sides) * TAU;
      pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
  }
  return pts;
}

export function spRadius(sp: number): number {
  return 1.5 + Math.sqrt(sp) * 0.85;
}

/**
 * Draws one bug. Shared with the colony's style previews, and with the
 * ants themselves: `opts.rotate` turns a bug drawn head-up into one drawn
 * head-forward, and `opts.legSwing` drives its legs from a walk cycle
 * instead of the clock, so a walking ant can wear it as a skin.
 */
export function drawBug(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  t: number,
  shape: BugShape,
  color: string,
  ink = cssAlpha("var(--text)", 0.82),
  opts?: { rotate?: number; legSwing?: number },
) {
  color = css(color);
  ink = css(ink);
  const w = opts?.legSwing ?? Math.sin(t * 60) * 0.9;
  ctx.save();
  ctx.translate(x, y);
  if (opts?.rotate) ctx.rotate(opts.rotate);
  ctx.scale(s, s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 0.9;
  const E = (cx: number, cy: number, rx: number, ry: number, rot = 0) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rot, 0, TAU);
    ctx.fill();
  };
  if (shape === "ant") {
    // The colony's own ant: three segments, six legs, two antennae.
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = -1; i <= 1; i++) {
      const o = i === 0 ? -w : w;
      ctx.moveTo(0, -i * 1.2);
      ctx.lineTo(-3.3, -i * 2.6 - o);
      ctx.moveTo(0, -i * 1.2);
      ctx.lineTo(3.3, -i * 2.6 + o);
    }
    ctx.moveTo(-0.5, -3);
    ctx.lineTo(-2, -5.2);
    ctx.moveTo(0.5, -3);
    ctx.lineTo(2, -5.2);
    ctx.stroke();
    ctx.fillStyle = color;
    E(0, 3.3, 1.6, 2.3);
    E(0, 0.2, 0.95, 1.3);
    E(0, -2.3, 1.15, 1.25);
  } else if (shape === "spider") {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const ly = -2.4 + i * 1.6;
      const o = i % 2 ? w : -w;
      ctx.moveTo(-1.2, ly * 0.4);
      ctx.lineTo(-4.4, ly - 2.2 + o);
      ctx.lineTo(-6.6, ly + 1.8 + o);
      ctx.moveTo(1.2, ly * 0.4);
      ctx.lineTo(4.4, ly - 2.2 - o);
      ctx.lineTo(6.6, ly + 1.8 - o);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    E(0, -1.6, 2, 2);
    E(0, 2.6, 3, 3.4);
    ctx.fillStyle = cssAlpha("var(--cream)", 0.45);
    E(0, 2.2, 0.8, 1.2);
  } else if (shape === "moth") {
    const f = 0.7 + Math.abs(Math.sin(t * 28)) * 0.3;
    ctx.fillStyle = color;
    E(-3.4 * f, -1.4, 3.6 * f, 2.6, -0.5);
    E(3.4 * f, -1.4, 3.6 * f, 2.6, 0.5);
    const ga = ctx.globalAlpha;
    ctx.globalAlpha = ga * 0.75;
    E(-2.6 * f, 2.4, 2.4 * f, 1.8, 0.4);
    E(2.6 * f, 2.4, 2.4 * f, 1.8, -0.4);
    ctx.globalAlpha = ga;
    ctx.fillStyle = ink;
    E(0, 0.6, 1, 4);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(-0.4, -3.2);
    ctx.quadraticCurveTo(-1.6, -5.6, -2.8, -6);
    ctx.moveTo(0.4, -3.2);
    ctx.quadraticCurveTo(1.6, -5.6, 2.8, -6);
    ctx.stroke();
  } else {
    ctx.strokeStyle = ink;
    ctx.beginPath();
    [-2, 0.2, 2.4].forEach((ly, i) => {
      const o = i % 2 ? w : -w;
      ctx.moveTo(-2.4, ly);
      ctx.lineTo(-5, ly - 1.2 + o);
      ctx.moveTo(2.4, ly);
      ctx.lineTo(5, ly - 1.2 - o);
    });
    if (shape === "stag") {
      ctx.moveTo(-0.9, -5.2);
      ctx.quadraticCurveTo(-3, -7, -1.2, -8.8);
      ctx.moveTo(0.9, -5.2);
      ctx.quadraticCurveTo(3, -7, 1.2, -8.8);
    } else {
      ctx.moveTo(-0.8, -5.4);
      ctx.lineTo(-2, -7.4 + w * 0.5);
      ctx.moveTo(0.8, -5.4);
      ctx.lineTo(2, -7.4 - w * 0.5);
    }
    ctx.stroke();
    if (shape === "ladybird") {
      ctx.fillStyle = ink;
      E(0, -3.6, 1.9, 1.6);
      ctx.fillStyle = color;
      E(0, 1, 4.1, 4.1);
      ctx.fillStyle = ink;
      for (const [a, b] of [
        [-1.8, -0.4],
        [1.8, -0.4],
        [-2.2, 2.4],
        [2.2, 2.4],
        [0, 3.8],
      ] as const) {
        E(a, b, 0.75, 0.75);
      }
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, -2.8);
      ctx.lineTo(0, 5);
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      E(0, 0.8, 3.1, 3.9);
      E(0, -4, 1.7, 1.7);
      ctx.strokeStyle = cssAlpha("var(--cream)", 0.4);
      ctx.beginPath();
      ctx.moveTo(0, -2.6);
      ctx.lineTo(0, 4.4);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function oct(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = rot + Math.PI / 8 + (i * Math.PI) / 4;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

function backOut(k: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

function wrap(a: number) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

export class ColonyFx {
  private canvas: HTMLCanvasElement | null = null;
  /** Over every menu and dialog: squashes, rings and bursts, never ants. */
  private topCanvas: HTMLCanvasElement | null = null;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private reduced = false;
  private parts: Particle[] = [];
  private rings: Ring[] = [];
  private pops: Pop[] = [];
  private flyers: Flyer[] = [];
  private carriersList: Carrier[] = [];
  private splats: Splat[] = [];
  private crewMap = new Map<string, Crew>();
  private trails = new Map<string, Trail>();
  /** Called every frame, for DOM that animates off the same clock. */
  onFrame: ((now: number) => void) | null = null;

  private world: FxWorld = {
    crews: new Map(),
    level: 1,
    ants: "busy",
    full: true,
    bugShape: "ant",
    bugHex: COLOR_UNLOCKS[0]!.hex,
    covered: false,
  };

  constructor(private readonly sound: SoundEngine) {}

  setWorld(world: FxWorld) {
    this.world = world;
  }

  /** The colour bugs are drawn in right now. */
  get bugHex() {
    return this.world.bugHex;
  }

  private sfx(n: Parameters<SoundEngine["play"]>[0], v = 0) {
    this.sound.play(n, v);
  }

  mount(canvas: HTMLCanvasElement, top?: HTMLCanvasElement): () => void {
    this.canvas = canvas;
    this.topCanvas = top ?? null;
    this.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const resize = () => {
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const cv of [canvas, top]) {
        if (!cv) continue;
        cv.width = window.innerWidth * this.dpr;
        cv.height = window.innerHeight * this.dpr;
      }
    };
    resize();
    window.addEventListener("resize", resize);
    // A theme switch re-resolves every colour.
    const theme = new MutationObserver(() => resolved.clear());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.last = performance.now();
    const loop = (now: number) => {
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(this.raf);
      window.removeEventListener("resize", resize);
      theme.disconnect();
      this.canvas = null;
      this.topCanvas = null;
    };
  }

  get reducedMotion() {
    return this.reduced;
  }

  private full() {
    return this.world.full && !this.reduced;
  }

  /* ---------------------------------------------------------------- fx */

  burst(
    x: number,
    y: number,
    colors: string[],
    n: number,
    o: {
      angle?: number;
      spread?: number;
      speed?: number;
      g?: number;
      life?: number;
      size?: number;
      shape?: "oct" | "dot";
    } = {},
  ) {
    if (this.reduced) return;
    if (!this.full()) n = Math.ceil(n / 3);
    for (let i = 0; i < n; i++) {
      const a = (o.angle ?? -Math.PI / 2) + (Math.random() - 0.5) * (o.spread ?? TAU);
      const sp = (o.speed ?? 220) * (0.4 + Math.random() * 0.8);
      const life = (o.life ?? 0.8) * (0.7 + Math.random() * 0.5);
      this.parts.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        g: o.g ?? 520,
        life,
        max: life,
        size: (o.size ?? 3) * (0.6 + Math.random() * 0.8),
        color: css(colors[i % colors.length]!),
        rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 12,
        shape: o.shape ?? "oct",
      });
    }
  }

  ring(x: number, y: number, color: string, r1 = 42, dur = 0.45, w = 2) {
    if (this.reduced) return;
    this.rings.push({ x, y, r1, color: css(color), life: dur, max: dur, w });
  }

  pop(x: number, y: number, text: string, sub: string | null, color: string, size = 20) {
    this.pops.push({ x, y, text, sub, color: css(color), size, life: 1.15, max: 1.15 });
  }

  /** A pop anchored on an element's top edge. */
  mark(el: Element, text: string, sub: string | null, color = "var(--text-muted)", size = 14) {
    const r = el.getBoundingClientRect();
    this.pop(r.left + r.width / 2, r.top + 4, text, sub, color, size);
  }

  fly(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    n: number,
    color: string,
    onEach?: (i: number) => void,
  ) {
    if (this.reduced) {
      for (let i = 0; i < n; i++) onEach?.(i);
      return;
    }
    for (let i = 0; i < n; i++) {
      const cx = (x0 + x1) / 2 + (Math.random() - 0.5) * 240;
      const cy = Math.min(y0, y1) - 40 - Math.random() * 120;
      this.flyers.push({
        x0: x0 + (Math.random() - 0.5) * 30,
        y0,
        x1,
        y1,
        cx,
        cy,
        t: 0,
        dur: 0.5 + Math.random() * 0.2,
        delay: i * 0.055,
        color: css(color),
        i,
        onEach,
        trail: [],
      });
    }
  }

  shake(m = 3) {
    if (!this.full()) return;
    const el = colonyEl("board");
    el?.animate(
      [
        { transform: "none" },
        { transform: `translate(${-m}px,${m * 0.6}px)` },
        { transform: `translate(${m}px,${-m * 0.5}px)` },
        { transform: `translate(${-m * 0.5}px,${m * 0.3}px)` },
        { transform: "none" },
      ],
      { duration: 240, easing: "ease-out" },
    );
  }

  squish(el: Element) {
    if (this.reduced || heldByDrag(el)) return;
    el.animate(
      [
        { transform: "translateY(-6px) scale(1.03,0.97)" },
        { transform: "scale(1.05,0.93)", offset: 0.35 },
        { transform: "scale(0.98,1.03)", offset: 0.65 },
        { transform: "none" },
      ],
      { duration: this.full() ? 320 : 160, easing: "ease-out" },
    );
  }

  /** Ants carrying something home to the nest. */
  carriers(x: number, y: number, n: number, color: string) {
    if (!this.antsOn()) return;
    for (let i = 0; i < n; i++) {
      this.carriersList.push({
        x: x + (Math.random() - 0.5) * 30,
        y: y + 4,
        a: Math.PI / 2,
        ph: Math.random() * 6,
        wait: i * 0.18,
        carry: css(color),
      });
    }
  }

  /** A bug hops up, lands and is squashed; `onSquash` fires on impact. */
  squash(x: number, y: number, onSquash: () => void, blobs = 9) {
    if (this.reduced) {
      onSquash();
      return;
    }
    this.splats.push({
      x,
      y,
      t: 0,
      onSquash,
      blobs: Array.from({ length: blobs }, () => ({
        dx: (Math.random() - 0.5) * 26,
        dy: (Math.random() - 0.5) * 9,
        r: 0.8 + Math.random() * 1.8,
      })),
    });
  }

  /* ------------------------------------------------------------- frame */

  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.onFrame?.(now);
    const c = this.canvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width / dpr, c.height / dpr);
    const top = this.topCanvas?.getContext("2d") ?? ctx;
    if (top !== ctx) {
      top.setTransform(dpr, 0, 0, dpr, 0, 0);
      top.clearRect(0, 0, c.width / dpr, c.height / dpr);
    }
    const [nx, ny] = this.nestPoint();

    for (let i = this.splats.length - 1; i >= 0; i--) {
      const b = this.splats[i]!;
      b.t += dt;
      if (b.t > 2.2) {
        this.splats.splice(i, 1);
        continue;
      }
      if (b.t < 0.42) {
        const k = Math.min(1, b.t / 0.22);
        const hop = -Math.sin(Math.min(1, b.t / 0.42) * Math.PI) * 12;
        drawBug(top, b.x, b.y + hop, Math.max(0.01, backOut(k) * 2.1), b.t, this.world.bugShape, this.world.bugHex);
      } else {
        if (!b.hit) {
          b.hit = true;
          b.onSquash();
        }
        const k = (b.t - 0.42) / 1.78;
        top.save();
        top.globalAlpha = Math.max(0, 1 - k * k) * 0.85;
        top.fillStyle = this.world.bugHex;
        top.beginPath();
        top.ellipse(b.x, b.y + 2, 10, 2.6, 0, 0, TAU);
        top.fill();
        top.globalAlpha *= 0.7;
        for (const o of b.blobs) {
          top.beginPath();
          top.arc(b.x + o.dx, b.y + 2 + o.dy, o.r, 0, TAU);
          top.fill();
        }
        top.restore();
      }
    }

    this.updateCrews(dt, ctx, nx, ny);
    this.blitTrails();

    const K = this.carriersList;
    for (let i = K.length - 1; i >= 0; i--) {
      const k = K[i]!;
      if ((k.wait -= dt) > 0) continue;
      if (this.stepAnt(k, nx, ny, 100, dt)) {
        K.splice(i, 1);
        this.sfx("enter", i);
        continue;
      }
      this.drawAnt(ctx, k.x, k.y, k.a, k.ph, k.carry);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const g = this.rings[i]!;
      g.life -= dt;
      if (g.life <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      const t = 1 - g.life / g.max;
      const e = 1 - Math.pow(1 - t, 3);
      top.globalAlpha = 1 - t;
      top.strokeStyle = g.color;
      top.lineWidth = g.w * (1 - t) + 0.5;
      oct(top, g.x, g.y, 6 + g.r1 * e, 0);
      top.stroke();
    }
    top.globalAlpha = 1;

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.parts.splice(i, 1);
        continue;
      }
      p.vy += p.g * dt;
      p.vx *= 0.985;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      top.globalAlpha = Math.min(1, (p.life / p.max) * 1.6);
      top.fillStyle = p.color;
      if (p.shape === "dot") {
        top.beginPath();
        top.arc(p.x, p.y, p.size, 0, TAU);
        top.fill();
      } else {
        oct(top, p.x, p.y, p.size, p.rot);
        top.fill();
      }
    }
    top.globalAlpha = 1;

    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i]!;
      if ((f.delay -= dt) > 0) continue;
      f.t += dt / f.dur;
      const t = Math.min(1, f.t);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const u = 1 - e;
      const x = u * u * f.x0 + 2 * u * e * f.cx + e * e * f.x1;
      const y = u * u * f.y0 + 2 * u * e * f.cy + e * e * f.y1;
      f.trail.push([x, y]);
      if (f.trail.length > 7) f.trail.shift();
      ctx.fillStyle = f.color;
      f.trail.forEach(([tx, ty], j) => {
        ctx.globalAlpha = ((j + 1) / f.trail.length) * 0.3;
        oct(ctx, tx, ty, 1.5 + j * 0.3, 0);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      oct(ctx, x, y, 3.8, t * 9);
      ctx.fill();
      if (f.t >= 1) {
        this.flyers.splice(i, 1);
        f.onEach?.(f.i);
      }
    }

    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.pops.splice(i, 1);
        continue;
      }
      const t = 1 - p.life / p.max;
      const sc = this.reduced ? 1 : t < 0.1 ? 0.5 + (t / 0.1) * 0.85 : t < 0.2 ? 1.35 - ((t - 0.1) / 0.1) * 0.35 : 1;
      const a = t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1;
      const yy = p.y - (this.reduced ? 0 : 34 * (1 - Math.pow(1 - t, 2)));
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      ctx.translate(p.x, yy);
      if (!this.reduced) ctx.rotate(Math.sin(t * 22) * 0.07 * (1 - t));
      ctx.scale(sc, sc);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.font = `700 ${p.size}px "Plus Jakarta Sans", system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = css("var(--card)");
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      if (p.sub) {
        ctx.font = '500 10px "JetBrains Mono", monospace';
        ctx.lineWidth = 4;
        ctx.strokeText(p.sub, 0, p.size * 0.9);
        ctx.fillStyle = css("var(--text)");
        ctx.fillText(p.sub, 0, p.size * 0.9);
      }
      ctx.restore();
    }
  }

  /* -------------------------------------------------------------- ants */

  private antsOn() {
    return this.world.ants !== "off" && !this.reduced;
  }

  private nestPoint(): [number, number] {
    const el = colonyEl("nest");
    if (!el) return [30, window.innerHeight - 28];
    const r = el.getBoundingClientRect();
    if (!r.width) return [30, window.innerHeight - 28];
    return [r.left + r.width / 2, r.top + r.height / 2 + 4];
  }

  private stepAnt(ant: { x: number; y: number; a: number; ph: number }, tx: number, ty: number, speed: number, dt: number) {
    const dx = tx - ant.x;
    const dy = ty - ant.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.min(dist, speed * dt);
    if (dist > 0.01) {
      ant.x += (dx / dist) * step;
      ant.y += (dy / dist) * step;
      ant.a += wrap(Math.atan2(dy, dx) - ant.a) * Math.min(1, dt * 14);
      ant.ph += step * 0.9;
    }
    return dist < 2;
  }

  private drawAnt(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    a: number,
    ph: number,
    carry: string | { sp: number } | null,
    sc = 1,
  ) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    if (sc !== 1) ctx.scale(sc, sc);
    // Ants wear whatever bug style the colony has equipped: same shapes and
    // colours as the picker, just rotated head-forward and leg-driven by the
    // walk cycle instead of the clock. Squashed bugs never take this path.
    const sw = Math.sin(ph) * 1.3;
    drawBug(ctx, 0, 0, this.world.bugShape === "ant" ? 1 : 0.62, 0, this.world.bugShape, this.world.bugHex, undefined, {
      rotate: Math.PI / 2,
      legSwing: sw,
    });
    if (carry && typeof carry === "object") {
      const r = spRadius(carry.sp);
      ctx.translate(4.4 + r * 0.9, Math.sin(ph * 0.5) * 0.3);
      ctx.rotate(-a);
      const p = spVerts(carry.sp, 0, 0, r);
      ctx.beginPath();
      p.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      ctx.fillStyle = css("var(--clay)");
      ctx.fill();
      ctx.strokeStyle = css("var(--terracotta-deep)");
      ctx.lineWidth = 0.7;
      ctx.stroke();
    } else if (carry) {
      ctx.fillStyle = carry;
      ctx.beginPath();
      ctx.arc(5.6, 0, 1.8, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  private perim(r: DOMRect, t: number): [number, number] {
    const d = 5;
    const x0 = r.left - d;
    const y0 = r.top - d;
    const w = r.width + 2 * d;
    const h = r.height + 2 * d;
    const P = 2 * (w + h);
    let s = ((t % P) + P) % P;
    if (s < w) return [x0 + s, y0];
    s -= w;
    if (s < h) return [x0 + w, y0 + s];
    s -= h;
    if (s < w) return [x0 + w - s, y0 + h];
    s -= w;
    return [x0, y0 + h - s];
  }

  /** One ant per story point, up to the top of the scale. */
  private crewSize(sp: number) {
    const n = Math.min(MAX_CREW, Math.max(1, Math.round(sp)));
    return this.world.ants === "few" ? Math.min(2, n) : n;
  }

  private badgePos(el: Element | null, r: DOMRect): [number, number] {
    const b = el?.querySelector("[data-sp]");
    if (!b) return [r.right - 20, r.top + 14];
    const q = b.getBoundingClientRect();
    return [q.left + 10, q.top + q.height / 2];
  }

  private puff(x: number, y: number) {
    this.burst(x, y, ["var(--dot-idle)", "var(--border-dashed)"], 5, { speed: 50, g: 0, life: 0.35, size: 1.3, shape: "dot" });
  }

  private spawnCrew(id: string, sp: number, phase: CrewPhase) {
    const [nx, ny] = this.nestPoint();
    const n = this.crewSize(sp);
    const ants: Ant[] = Array.from({ length: n }, (_, i) => ({
      x: nx,
      y: ny,
      a: Math.PI,
      ph: Math.random() * 6,
      mode: "wait",
      wait: i * 0.38,
      idx: i,
      leader: i === 0,
      t: Math.random() * 600,
      sp: 16 + Math.random() * 12,
    }));
    this.crewMap.set(id, { id, sp, phase, ants });
  }

  private edgeOut(r: DOMRect, lx: number, ly: number): [number, number] {
    const dl = lx;
    const dr = r.width - lx;
    const dtp = ly;
    const db = r.height - ly;
    const m = Math.min(dl, dr, dtp, db);
    if (m === dl) return [r.left - 5, r.top + ly];
    if (m === dr) return [r.right + 5, r.top + ly];
    if (m === dtp) return [r.left + lx, r.top - 5];
    return [r.left + lx, r.bottom + 5];
  }

  private transition(c: Crew, d: CrewPhase, r: DOMRect | null) {
    const prev = c.phase;
    c.phase = d;
    let k = 0;
    for (const ant of c.ants) {
      if (ant.mode === "wait") {
        if (d === "buried" || d === "leave") ant.gone = true;
        continue;
      }
      if (d === "buried") {
        if (ant.mode === "buried" || ant.mode === "home" || ant.mode === "out") continue;
        if (r) {
          ant.lx = ant.x - r.left;
          ant.ly = ant.y - r.top;
        }
        ant.mode = "dig";
        ant.anim = -k * 0.1;
        ant.puffed = false;
        ant.carry = false;
        k++;
      } else if (d === "tunnel") {
        if (ant.mode === "buried" || ant.mode === "perim" || ant.mode === "dig") {
          if (r) {
            if (ant.mode !== "buried") {
              ant.lx = ant.x - r.left;
              ant.ly = ant.y - r.top;
            }
            ant.lx = Math.max(10, Math.min(r.width - 10, ant.lx ?? 10));
            ant.ly = Math.max(10, Math.min(r.height - 10, ant.ly ?? 10));
          }
          ant.mode = "rise";
          ant.anim = -k * 0.14;
          ant.puffed = false;
          ant.carry = false;
          k++;
        }
      } else if (d === "work") {
        if (ant.mode === "buried" || ant.mode === "tunnel" || ant.mode === "rise" || ant.mode === "dig") {
          ant.mode = "walk";
        }
      } else {
        if (ant.mode === "home" || ant.mode === "out") continue;
        ant.hidden =
          ant.mode === "buried" || ant.mode === "dig" || (ant.mode === "rise" && (ant.anim ?? 0) < 0);
        ant.mode = "out";
        ant.wait = k * 0.22;
        ant.carry = ant.leader;
        k++;
      }
    }
    if (d === "buried" && prev !== "buried" && k) this.sfx("burrow");
  }

  private updateCrews(dt: number, ctx: CanvasRenderingContext2D, nx: number, ny: number) {
    const want = this.world.crews;
    if (this.antsOn()) {
      for (const [id, w] of want) {
        if ((w.phase === "work" || w.phase === "tunnel") && !this.crewMap.has(id)) {
          this.spawnCrew(id, w.sp, w.phase);
        }
      }
    }
    for (const [id, c] of this.crewMap) {
      const w = want.get(id);
      const d: CrewPhase = w ? w.phase : "leave";
      const el = cardEl(id);
      const rr = el?.getBoundingClientRect() ?? null;
      const r = rr && rr.width > 0 ? rr : null;
      if (w) c.sp = w.sp;
      if (d !== c.phase) this.transition(c, d, r);
      for (const ant of c.ants) this.stepCrewAnt(c, ant, r, el, dt, nx, ny, ctx);
      c.ants = c.ants.filter((a) => !a.gone);
      const pg = el?.querySelector<SVGElement>("[data-sp] polygon");
      if (pg) pg.style.fill = c.phase === "work" && c.ants.some((a) => a.carry) ? "transparent" : "";
      if (!c.ants.length) this.crewMap.delete(id);
    }
  }

  private stepCrewAnt(
    c: Crew,
    ant: Ant,
    r: DOMRect | null,
    el: Element | null,
    dt: number,
    nx: number,
    ny: number,
    ctx: CanvasRenderingContext2D,
  ) {
    const follow = () => {
      if (r) {
        ant.x = r.left + (ant.lx ?? 0);
        ant.y = r.top + (ant.ly ?? 0);
      }
    };
    let sc = 1;
    switch (ant.mode) {
      case "wait":
        if ((ant.wait -= dt) > 0) return;
        if (c.phase === "leave" || c.phase === "buried" || !r) {
          ant.gone = true;
          return;
        }
        ant.mode = "walk";
        ant.x = nx;
        ant.y = ny;
        this.sfx("emerge", ant.idx);
        this.puff(nx, ny);
        break;
      case "walk": {
        if (!r) {
          ant.mode = "home";
          break;
        }
        if (ant.leader && c.phase === "work" && !ant.carry) {
          const [bx, by] = this.badgePos(el, r);
          if (this.stepAnt(ant, bx, by, 170, dt)) {
            ant.carry = true;
            this.sfx("grab");
            this.ring(bx, by, "var(--clay)", 14, 0.3, 1.5);
          }
        } else {
          const [tx, ty] = this.perim(r, ant.t);
          if (this.stepAnt(ant, tx, ty, 170, dt)) {
            this.sfx("attach", ant.idx);
            if (c.phase === "tunnel") {
              ant.lx = Math.max(10, Math.min(r.width - 10, ant.x - r.left));
              ant.ly = Math.max(10, Math.min(r.height - 10, ant.y - r.top));
              ant.mode = "rise";
              ant.anim = 0;
              ant.puffed = false;
            } else ant.mode = "perim";
          }
        }
        break;
      }
      case "perim": {
        if (!r) {
          ant.mode = "home";
          break;
        }
        ant.t += ant.sp * dt;
        const [tx, ty] = this.perim(r, ant.t);
        this.stepAnt(ant, tx, ty, 9999, dt);
        break;
      }
      case "dig":
        follow();
        ant.anim = (ant.anim ?? 0) + ((ant.anim ?? 0) < 0 ? dt : dt / 0.3);
        if (ant.anim >= 0 && !ant.puffed) {
          ant.puffed = true;
          this.puff(ant.x, ant.y);
        }
        if (ant.anim >= 1) {
          ant.mode = "buried";
          return;
        }
        sc = ant.anim < 0 ? 1 : 1 - ant.anim;
        break;
      case "buried":
        follow();
        return;
      case "rise":
        follow();
        ant.anim = (ant.anim ?? 0) + ((ant.anim ?? 0) < 0 ? dt : dt / 0.3);
        if (ant.anim < 0) return;
        if (!ant.puffed) {
          ant.puffed = true;
          this.puff(ant.x, ant.y);
        }
        if (ant.anim >= 1) {
          ant.mode = "tunnel";
          ant.h = Math.random() * TAU;
          ant.th = ant.h;
          ant.choose = 0;
        }
        sc = Math.min(1, ant.anim);
        ant.a = ant.h ?? ant.a;
        break;
      case "tunnel":
        if (!r) {
          ant.mode = "home";
          break;
        }
        this.tunnelStep(c.id, ant, r, dt);
        break;
      case "out":
        if (ant.hidden) follow();
        if ((ant.wait -= dt) > 0) {
          if (ant.hidden) return;
          break;
        }
        if (ant.hidden && r) {
          const p = this.edgeOut(r, ant.lx ?? 0, ant.ly ?? 0);
          ant.x = p[0];
          ant.y = p[1];
          this.puff(ant.x, ant.y);
        }
        ant.hidden = false;
        ant.mode = "home";
        this.sfx("detach", ant.idx);
        break;
      case "home":
        if (this.stepAnt(ant, nx, ny, 120, dt)) {
          ant.gone = true;
          this.sfx("enter", ant.idx);
          this.puff(nx, ny);
          return;
        }
        break;
    }
    if (!this.world.covered) {
      this.drawAnt(ctx, ant.x, ant.y, ant.a, ant.ph, ant.carry ? { sp: c.sp } : null, sc);
    }
  }

  private trail(id: string, r: DOMRect): Trail {
    let tr = this.trails.get(id);
    if (!tr) {
      const cv = document.createElement("canvas");
      cv.width = Math.max(40, Math.round(r.width * 2));
      cv.height = Math.max(40, Math.round(r.height * 2));
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = css("var(--text)");
      tr = { cv, ctx, grid: new Uint8Array(32 * 16), ver: 0 };
      this.trails.set(id, tr);
    }
    return tr;
  }

  private cell(u: number, v: number) {
    return Math.min(15, Math.max(0, Math.floor(v * 16))) * 32 + Math.min(31, Math.max(0, Math.floor(u * 32)));
  }

  private tunnelStep(id: string, ant: Ant, r: DOMRect, dt: number) {
    const tr = this.trail(id, r);
    const W = r.width;
    const H = r.height;
    ant.lx ??= W / 2;
    ant.ly ??= H / 2;
    ant.h ??= 0;
    ant.th ??= ant.h;
    ant.choose = (ant.choose ?? 0) - dt;
    if (ant.choose <= 0) {
      ant.choose = 0.16 + Math.random() * 0.2;
      let best = ant.h;
      let bs = -1e9;
      for (let k = -2; k <= 2; k++) {
        const hh = ant.h + k * 0.6 + (Math.random() - 0.5) * 0.3;
        const px = ant.lx + Math.cos(hh) * 16;
        const py = ant.ly + Math.sin(hh) * 16;
        let s = Math.random() * 0.6 + (k === 0 ? 0.4 : 0);
        if (px < 7 || py < 7 || px > W - 7 || py > H - 7) s -= 5;
        else if (!tr.grid[this.cell(px / W, py / H)]) s += 2;
        if (s > bs) {
          bs = s;
          best = hh;
        }
      }
      ant.th = best;
    }
    ant.h += wrap(ant.th - ant.h) * Math.min(1, dt * 6);
    const step = 42 * dt;
    ant.lx += Math.cos(ant.h) * step;
    ant.ly += Math.sin(ant.h) * step;
    if (ant.lx < 6 || ant.lx > W - 6) {
      ant.h = Math.PI - ant.h;
      ant.th = ant.h;
      ant.lx = Math.max(6, Math.min(W - 6, ant.lx));
    }
    if (ant.ly < 6 || ant.ly > H - 6) {
      ant.h = -ant.h;
      ant.th = ant.h;
      ant.ly = Math.max(6, Math.min(H - 6, ant.ly));
    }
    const u = ant.lx / W;
    const v = ant.ly / H;
    tr.grid[this.cell(u, v)] = 1;
    tr.ctx.beginPath();
    tr.ctx.arc(u * tr.cv.width, v * tr.cv.height, 7, 0, TAU);
    tr.ctx.fill();
    tr.ver++;
    ant.x = r.left + ant.lx;
    ant.y = r.top + ant.ly;
    ant.a = ant.h;
    ant.ph += step * 0.9;
  }

  /** A card whose crew already dug through it: trails without the wait. */
  private presim(id: string, r: DOMRect) {
    const ants: Ant[] = Array.from({ length: 4 }, (_, i) => {
      const h = Math.random() * TAU;
      return {
        x: 0,
        y: 0,
        a: 0,
        ph: 0,
        mode: "tunnel" as const,
        wait: 0,
        idx: i,
        leader: false,
        t: 0,
        sp: 0,
        lx: 10 + Math.random() * (r.width - 20),
        ly: 10 + Math.random() * (r.height - 20),
        h,
        th: h,
        choose: 0,
      };
    });
    for (let i = 0; i < 300; i++) for (const a of ants) this.tunnelStep(id, a, r, 1 / 30);
  }

  private blitTrails() {
    const dpr = this.dpr;
    const want = this.world.crews;
    document.querySelectorAll<HTMLElement>("[data-tid]").forEach((el) => {
      const id = el.getAttribute("data-tid")!;
      const cv = el.querySelector<TrailCanvas>("canvas[data-trail]");
      if (!cv) return;
      const w = want.get(id);
      let tr = w ? this.trails.get(id) : undefined;
      if (!w) this.trails.delete(id);
      if (!tr && w?.phase === "buried" && this.antsOn()) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          this.presim(id, r);
          tr = this.trails.get(id);
        }
      }
      if (!tr) {
        if (cv.__id) {
          cv.getContext("2d")?.clearRect(0, 0, cv.width, cv.height);
          cv.__id = null;
        }
        return;
      }
      const cw = Math.round(el.clientWidth * dpr);
      const ch = Math.round(el.clientHeight * dpr);
      if (cv.width !== cw || cv.height !== ch) {
        cv.width = cw;
        cv.height = ch;
        cv.__v = -1;
      }
      if (cv.__v === tr.ver && cv.__id === id) return;
      cv.__v = tr.ver;
      cv.__id = id;
      const x = cv.getContext("2d");
      if (!x) return;
      x.clearRect(0, 0, cw, ch);
      x.globalAlpha = 0.075;
      x.drawImage(tr.cv, 0, 0, cw, ch);
      x.globalAlpha = 1;
    });
  }
}
