import { describe, expect, it, vi } from "vitest";
import { ColonyFx, heldByDrag } from "./fx";
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
