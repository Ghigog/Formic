import { describe, expect, it, vi } from "vitest";
import { ColonyFx, clipSetFor, heldByDrag, travelRects, visibleRects } from "./fx";
import { SoundEngine } from "./sound";

/**
 * The drag library moves a card it holds with a transform transition and
 * only calls the drop done when that transition ends. An effect animating
 * the same card's transform cancels it, and the drag hangs with the card
 * never leaving the column it was picked up from. That is how an Epic pulled
 * back to Backlog stayed in To Do: its status changed as the drop animated,
 * and the landing squish played on it.
 */
function draggable(style: Partial<CSSStyleDeclaration> = {}): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-rfd-draggable-id", "epic-4");
  Object.assign(el.style, style);
  el.animate = vi.fn();
  return el;
}

describe("heldByDrag", () => {
  it("is true while the library fixes the card to the viewport", () => {
    expect(heldByDrag(draggable({ position: "fixed" }))).toBe(true);
  });

  it("is true for anything inside that card", () => {
    const card = draggable({ position: "fixed" });
    const inner = document.createElement("span");
    card.append(inner);
    expect(heldByDrag(inner)).toBe(true);
  });

  it("is false for a card at rest, and for anything outside a card", () => {
    expect(heldByDrag(draggable())).toBe(false);
    expect(heldByDrag(document.createElement("div"))).toBe(false);
  });
});

describe("ColonyFx.squish", () => {
  const fx = () => new ColonyFx(new SoundEngine());

  it("squishes a card that has landed", () => {
    const el = draggable();
    fx().squish(el);
    expect(el.animate).toHaveBeenCalledOnce();
  });

  it("leaves a card alone while the drag library holds it", () => {
    const el = draggable({ position: "fixed" });
    fx().squish(el);
    expect(el.animate).not.toHaveBeenCalled();
  });
});

type Internals = {
  crewMap: Map<string, { id: string; sp: number; phase: string; ants: unknown[] }>;
  carriersList: unknown[];
  splats: unknown[];
};

describe("ColonyFx.antAt and squashAnt", () => {
  const ant = (o: Record<string, unknown> = {}) => ({
    x: 100,
    y: 100,
    a: 0,
    ph: 0,
    mode: "walk",
    wait: 0,
    idx: 0,
    leader: false,
    t: 0,
    sp: 20,
    ...o,
  });
  const setup = (phase = "work", ants: unknown[] = [ant()], sp = 1) => {
    const sound = new SoundEngine();
    const play = vi.spyOn(sound, "play").mockImplementation(() => {});
    const fx = new ColonyFx(sound);
    const inner = fx as unknown as Internals;
    inner.crewMap.set("c1", { id: "c1", sp, phase, ants });
    return { fx, inner, play };
  };

  it("keeps the same ants, walking, when a queued crew's card starts running", () => {
    const ants = [ant({ mode: "crowd", leader: true }), ant({ mode: "crowd", idx: 1 })];
    const { inner } = setup("queue", ants);
    const crew = inner.crewMap.get("c1")!;
    (inner as unknown as { transition: (c: unknown, d: string, r: null) => void }).transition(crew, "work", null);
    expect(inner.crewMap.get("c1")).toBe(crew);
    expect(crew.phase).toBe("work");
    expect(crew.ants).toHaveLength(2);
    crew.ants.forEach((a, i) => {
      expect(a).toBe(ants[i]);
      expect(a).toMatchObject({ mode: "walk" });
      expect((a as { hidden?: boolean }).hidden).toBeFalsy();
    });
  });

  it("finds an ant within reach of the pointer, not one far away", () => {
    const { fx, inner } = setup();
    const a = inner.crewMap.get("c1")!.ants[0];
    expect(fx.antAt(105, 104)).toBe(a);
    expect(fx.antAt(140, 100)).toBeNull();
  });

  it("finds ants in transit and carriers", () => {
    const { fx, inner } = setup("work", [ant({ mode: "out" })]);
    expect(fx.antAt(100, 100)).toBeTruthy();
    const carrier = { x: 300, y: 300, a: 0, ph: 0, wait: 0, carry: "#000" };
    inner.carriersList.push(carrier);
    expect(fx.antAt(300, 300)).toBe(carrier);
  });

  it("skips ants that are not drawn", () => {
    for (const o of [{ mode: "wait" }, { mode: "buried" }, { mode: "dig" }, { hidden: true }]) {
      expect(setup("tunnel", [ant(o)]).fx.antAt(100, 100)).toBeNull();
    }
  });

  it("finds nothing when ants are off, motion is reduced or the board is covered", () => {
    const base = { crews: new Map(), level: 1, ants: "busy" as const, full: true, bugShape: "ant" as const, bugHex: "#000", covered: false };
    const off = setup();
    off.fx.setWorld({ ...base, ants: "off" });
    expect(off.fx.antAt(100, 100)).toBeNull();
    const covered = setup();
    covered.fx.setWorld({ ...base, covered: true });
    expect(covered.fx.antAt(100, 100)).toBeNull();
    const reduced = setup();
    (reduced.fx as unknown as { reduced: boolean }).reduced = true;
    expect(reduced.fx.antAt(100, 100)).toBeNull();
  });

  it("squashes a crew ant with the squash sound and sends a replacement", () => {
    const { fx, inner, play } = setup("work", [ant({ leader: true, carry: true })], 1);
    const a = inner.crewMap.get("c1")!.ants[0];
    fx.squashAnt(a as never);
    expect(play).toHaveBeenCalledWith("squash", 0);
    const ants = inner.crewMap.get("c1")!.ants as Array<Record<string, unknown>>;
    expect(ants).toHaveLength(1);
    expect(ants[0]).not.toBe(a);
    expect(ants[0]).toMatchObject({ mode: "wait", leader: true });
    expect(ants[0]!.carry).toBeFalsy();
    expect(inner.splats).toHaveLength(1);
  });

  it("gives no replacement to a crew that is leaving or buried", () => {
    for (const phase of ["leave", "buried"]) {
      const { fx, inner } = setup(phase);
      fx.squashAnt(inner.crewMap.get("c1")!.ants[0] as never);
      expect(inner.crewMap.get("c1")!.ants).toHaveLength(0);
    }
  });

  it("squashes a carrier without replacing it", () => {
    const { fx, inner, play } = setup();
    const carrier = { x: 300, y: 300, a: 0, ph: 0, wait: 0, carry: "#000" };
    inner.carriersList.push(carrier);
    fx.squashAnt(carrier as never);
    expect(inner.carriersList).toHaveLength(0);
    expect(inner.crewMap.get("c1")!.ants).toHaveLength(1);
    expect(play).toHaveBeenCalledWith("squash", 0);
  });

  it("consumes the pointerdown on an ant and the click after it, but not elsewhere", () => {
    const { fx, inner } = setup();
    const unmount = fx.mount(document.createElement("canvas"));
    const down = (x: number, y: number) => {
      const e = new MouseEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e;
    };
    expect(down(500, 500).defaultPrevented).toBe(false);
    const e = down(100, 100);
    expect(e.defaultPrevented).toBe(true);
    expect(inner.crewMap.get("c1")!.ants).toHaveLength(1);
    const onClick = vi.fn();
    document.body.addEventListener("click", onClick);
    document.body.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).toHaveBeenCalledOnce();
    document.body.removeEventListener("click", onClick);
    unmount();
  });
});

describe("visibleRects", () => {
  const col = { left: 0, top: 0, right: 100, bottom: 100 };
  const area = (rs: { left: number; top: number; right: number; bottom: number }[]) =>
    rs.reduce((a, r) => a + (r.right - r.left) * (r.bottom - r.top), 0);

  it("is the column itself when nothing masks it", () => {
    expect(visibleRects(col, [])).toEqual([col]);
    expect(visibleRects(col, [{ left: 200, top: 0, right: 300, bottom: 50 }])).toEqual([col]);
  });

  it("leaves nothing when a mask covers the column", () => {
    expect(visibleRects(col, [{ left: -10, top: -10, right: 110, bottom: 110 }])).toEqual([]);
  });

  it("cuts a mask out of the column, including one that overlaps another", () => {
    const a = { left: 0, top: 60, right: 100, bottom: 200 };
    const b = { left: 50, top: 40, right: 80, bottom: 70 };
    const out = visibleRects(col, [a, b]);
    expect(area(out)).toBe(100 * 60 - 30 * 20);
    for (const r of out) expect(r.bottom <= 60 || r.right <= 50 || r.left >= 80 || r.top >= 70).toBe(true);
  });
});

describe("clipSetFor", () => {
  const col = { left: 100, top: 0, right: 200, bottom: 100 };

  it("lets an emerging ant outside its column draw over the board", () => {
    expect(clipSetFor("walk", false, 500, 500, col)).toBe("travel");
  });

  it("clips an emerging ant once it is inside the column, and after it has entered", () => {
    expect(clipSetFor("walk", false, 150, 50, col)).toBe("column");
    expect(clipSetFor("walk", true, 99, 50, col)).toBe("column");
  });

  it("lets an ant heading home draw over the board even inside its column", () => {
    expect(clipSetFor("home", true, 500, 500, col)).toBe("travel");
    expect(clipSetFor("home", true, 150, 50, col)).toBe("travel");
  });

  it("clips ants working in the column", () => {
    expect(clipSetFor("read", false, 500, 500, col)).toBe("column");
  });
});

describe("visibleRects with the viewport", () => {
  const view = { left: 0, top: 0, right: 1000, bottom: 800 };

  it("is the whole viewport without masks and minus a drawer mask", () => {
    expect(visibleRects(view, [])).toEqual([view]);
    const out = visibleRects(view, [{ left: 600, top: 0, right: 1000, bottom: 800 }]);
    expect(out).toEqual([{ left: 0, top: 0, right: 600, bottom: 800 }]);
  });
});

describe("travelRects", () => {
  it("is the whole viewport, not cut by a mask over the nest, while visibleRects is", () => {
    const view = { left: 0, top: 0, right: 1000, bottom: 800 };
    const barOverNest = { left: 800, top: 740, right: 1000, bottom: 800 };
    expect(travelRects(view)).toEqual([view]);
    expect(visibleRects(view, [barOverNest])).not.toEqual([view]);
  });
});

describe("ColonyFx crews on a card that is not rendered", () => {
  type Frame = { updateCrews(dt: number, ctx: unknown, nx: number, ny: number): void };
  const ctx = new Proxy({}, { get: () => () => ({}), set: () => true });
  const setup = (phase: "work" | "tunnel" = "work") => {
    const fx = new ColonyFx(new SoundEngine());
    const inner = fx as unknown as Internals & { world: unknown } & Frame;
    const ants = [0, 1].map((idx) => ({ x: 5, y: 5, a: 0, ph: 0, mode: "perim", wait: 0, idx, leader: false, t: 0, sp: 20 }));
    inner.crewMap.set("c1", { id: "c1", sp: 1, phase, ants });
    const want = (p: string | null) =>
      fx.setWorld({
        crews: new Map(p ? [["c1", { phase: p, sp: 1 }]] : []),
        level: 1,
        ants: "busy",
        full: true,
        bugShape: "ant",
        bugHex: "#000000",
        covered: false,
      } as never);
    want(phase);
    return { inner, ants, want, step: () => inner.updateCrews(0.016, ctx, 0, 0) };
  };
  const render = () => {
    const el = document.createElement("div");
    el.setAttribute("data-tid", "c1");
    el.getBoundingClientRect = () => ({ left: 50, top: 60, width: 100, height: 40, right: 150, bottom: 100 }) as DOMRect;
    document.body.appendChild(el);
    return el;
  };

  it("keeps its ants where they are, none going home, then resumes when the card returns", () => {
    const { inner, ants, step } = setup();
    step();
    step();
    expect(inner.crewMap.get("c1")!.ants).toEqual(ants);
    expect(ants.every((a) => a.mode === "perim" && a.x === 5)).toBe(true);
    const el = render();
    step();
    expect(inner.crewMap.get("c1")!.ants).toHaveLength(2);
    expect(ants.every((a) => a.mode === "perim")).toBe(true);
    el.remove();
  });

  it("does not spawn a crew for a wanted card with no element", () => {
    const { inner, want, step } = setup();
    inner.crewMap.clear();
    want("work");
    step();
    expect(inner.crewMap.size).toBe(0);
  });

  it("still dismisses a paused crew when its card leaves the board or changes phase", () => {
    const { inner, ants, want, step } = setup();
    want(null);
    step();
    expect(ants.every((a) => a.mode === "home" || a.mode === "out")).toBe(true);
    const b = setup();
    b.want("leave");
    b.step();
    expect(b.ants.every((a) => a.mode === "home" || a.mode === "out")).toBe(true);
    expect(inner.crewMap.get("c1")).toBeDefined();
  });

  it("transitions a paused crew on the next frame when its phase changes", () => {
    const { inner, want, step } = setup();
    want("tunnel");
    step();
    expect(inner.crewMap.get("c1")!.phase).toBe("tunnel");
  });
});
