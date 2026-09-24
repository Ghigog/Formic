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
