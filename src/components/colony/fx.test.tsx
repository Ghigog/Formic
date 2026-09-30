import { describe, expect, it, vi } from "vitest";
import { ColonyFx, heldByDrag, visibleRects } from "./fx";
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
