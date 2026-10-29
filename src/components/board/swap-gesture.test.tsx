import { describe, expect, it, vi } from "vitest";
import { createSwapGestures } from "./swap-gesture";

const boundary = document.createElement("div");
const target = document.createElement("div");
boundary.append(target);
const at = (x: number, y: number) => ({ clientX: x, clientY: y });

function setup() {
  const onSwap = vi.fn();
  return { onSwap, g: createSwapGestures(onSwap) };
}

describe("three-finger swipe", () => {
  it("requests a down swap for an upward swipe past the threshold", () => {
    const { g, onSwap } = setup();
    g.touchStart({ touches: [at(100, 300), at(120, 300), at(140, 300)], target }, boundary);
    g.touchEnd({ changedTouches: [at(102, 200)] });
    expect(onSwap).toHaveBeenCalledWith("down");
  });

  it("requests an up swap for a downward swipe", () => {
    const { g, onSwap } = setup();
    g.touchStart({ touches: [at(100, 100), at(120, 100), at(140, 100)], target }, boundary);
    g.touchEnd({ changedTouches: [at(100, 200)] });
    expect(onSwap).toHaveBeenCalledWith("up");
  });

  it("ignores one-finger sideways swipes", () => {
    const { g, onSwap } = setup();
    g.touchStart({ touches: [at(300, 100)], target }, boundary);
    g.touchEnd({ changedTouches: [at(100, 100)] });
    expect(onSwap).not.toHaveBeenCalled();
  });

  it("ignores one-finger vertical travel and short or sideways three-finger travel", () => {
    const { g, onSwap } = setup();
    g.touchStart({ touches: [at(0, 300)], target }, boundary);
    g.touchEnd({ changedTouches: [at(0, 100)] });
    const three = [at(0, 300), at(10, 300), at(20, 300)];
    g.touchStart({ touches: three, target }, boundary);
    g.touchEnd({ changedTouches: [at(0, 280)] });
    g.touchStart({ touches: three, target }, boundary);
    g.touchEnd({ changedTouches: [at(200, 200)] });
    expect(onSwap).not.toHaveBeenCalled();
  });

  it("ignores gestures that start in something that owns them", () => {
    const { g, onSwap } = setup();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    boundary.append(dialog);
    g.touchStart({ touches: [at(0, 300), at(10, 300), at(20, 300)], target: dialog }, boundary);
    g.touchEnd({ changedTouches: [at(0, 100)] });
    dialog.remove();
    expect(onSwap).not.toHaveBeenCalled();
  });
});

describe("right-button drag", () => {
  it("requests a down swap for an upward drag and suppresses the context menu", () => {
    const { g, onSwap } = setup();
    const preventDefault = vi.fn();
    g.pointerDown({ ...at(100, 300), button: 2, target }, boundary);
    g.pointerUp({ ...at(100, 200), button: 2 });
    g.contextMenu({ preventDefault });
    expect(onSwap).toHaveBeenCalledWith("down");
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves a right-click without a drag to open the menu", () => {
    const { g, onSwap } = setup();
    const preventDefault = vi.fn();
    g.pointerDown({ ...at(100, 300), button: 2, target }, boundary);
    g.pointerUp({ ...at(102, 298), button: 2 });
    g.contextMenu({ preventDefault });
    expect(onSwap).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("ignores the left button", () => {
    const { g, onSwap } = setup();
    g.pointerDown({ ...at(100, 300), button: 0, target }, boundary);
    g.pointerUp({ ...at(100, 100), button: 0 });
    expect(onSwap).not.toHaveBeenCalled();
  });
});
