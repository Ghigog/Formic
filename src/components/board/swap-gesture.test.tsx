import { describe, expect, it, vi } from "vitest";
import { createSwapGestures, MAX_PULL, pullFor } from "./swap-gesture";

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

describe("following the hand", () => {
  it("reports a three-finger swipe's travel as it goes, with resistance, and lets go at the end", () => {
    const onSwap = vi.fn();
    const onPull = vi.fn();
    const g = createSwapGestures(onSwap, onPull);
    g.touchStart({ touches: [at(100, 300), at(120, 300), at(140, 300)], target }, boundary);
    expect(g.touchMove({ touches: [at(100, 260), at(120, 260), at(140, 260)] })).toBe(true);
    const pulled = onPull.mock.calls.at(-1)![0] as number;
    expect(pulled).toBeLessThan(0);
    expect(pulled).toBeGreaterThan(-40);
    g.touchEnd({ changedTouches: [at(100, 200)] });
    expect(onPull).toHaveBeenLastCalledWith(null);
    expect(onSwap).toHaveBeenCalledWith("down");
  });

  it("never pulls further than a hint of the earth", () => {
    expect(Math.abs(pullFor(0, -2000))).toBeLessThanOrEqual(MAX_PULL);
    expect(pullFor(300, -20)).toBe(0);
  });

  it("does not claim a one-finger move, so the page scrolls as usual", () => {
    const { g } = setup();
    g.touchStart({ touches: [at(0, 300)], target }, boundary);
    expect(g.touchMove({ touches: [at(0, 200)] })).toBe(false);
  });

  it("follows a right-button drag too", () => {
    const onPull = vi.fn();
    const g = createSwapGestures(vi.fn(), onPull);
    g.pointerDown({ ...at(100, 300), button: 2, target }, boundary);
    g.pointerMove({ ...at(100, 250), buttons: 2 });
    expect(onPull.mock.calls.at(-1)![0]).toBeLessThan(0);
  });
});

describe("the context menu on macOS, which opens on the press", () => {
  it("is held back while a right-button drag is under way", () => {
    const { g } = setup();
    const preventDefault = vi.fn();
    g.pointerDown({ ...at(100, 300), button: 2, target }, boundary);
    g.contextMenu({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("opens as usual on a field, a link or editable text", () => {
    const { g, onSwap } = setup();
    const input = document.createElement("input");
    boundary.append(input);
    const preventDefault = vi.fn();
    g.pointerDown({ ...at(100, 300), button: 2, target: input }, boundary);
    g.contextMenu({ preventDefault });
    g.pointerUp({ ...at(100, 100), button: 2 });
    input.remove();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSwap).not.toHaveBeenCalled();
  });
});

describe("giving up a right-button drag", () => {
  const start = () => {
    const onSwap = vi.fn();
    const onPull = vi.fn();
    const onAim = vi.fn();
    const g = createSwapGestures(onSwap, onPull, onAim);
    g.pointerDown({ ...at(100, 300), button: 2, target }, boundary);
    g.pointerMove({ ...at(100, 220), buttons: 2 });
    onPull.mockClear();
    onAim.mockClear();
    return { g, onSwap, onPull, onAim };
  };
  const gaveUp = ({ g, onSwap, onPull, onAim }: ReturnType<typeof start>) => {
    expect(onPull).toHaveBeenLastCalledWith(null);
    expect(onAim).toHaveBeenLastCalledWith(null);
    expect(onSwap).not.toHaveBeenCalled();
    // A later release or move does nothing: the drag is over.
    onPull.mockClear();
    g.pointerMove({ ...at(100, 100), buttons: 2 });
    g.pointerUp({ ...at(100, 100), button: 2 });
    expect(onPull).not.toHaveBeenCalled();
    expect(onSwap).not.toHaveBeenCalled();
  };

  it("cancels when the pointer leaves the window, the window blurs or the browser cancels", () => {
    const s = start();
    s.g.cancel();
    gaveUp(s);
  });

  it("cancels on a move that no longer holds the right button", () => {
    const s = start();
    s.g.pointerMove({ ...at(100, 200), buttons: 0 });
    gaveUp(s);
  });

  it("cancels when another button is released", () => {
    const s = start();
    s.g.pointerUp({ ...at(100, 200), button: 0 });
    gaveUp(s);
  });
});

describe("aiming", () => {
  it("aims one threshold above the press, armed once the drag travels up past it", () => {
    const onAim = vi.fn();
    const g = createSwapGestures(vi.fn(), vi.fn(), onAim);
    g.pointerDown({ ...at(100, 300), button: 2, target }, boundary);
    expect(onAim).toHaveBeenLastCalledWith({ x: 100, y: 240, armed: false });
    g.pointerMove({ ...at(100, 270), buttons: 2 });
    expect(onAim).toHaveBeenLastCalledWith({ x: 100, y: 240, armed: false });
    g.pointerMove({ ...at(100, 235), buttons: 2 });
    expect(onAim).toHaveBeenLastCalledWith({ x: 100, y: 240, armed: true });
    g.pointerUp({ ...at(100, 235), button: 2 });
    expect(onAim).toHaveBeenLastCalledWith(null);
  });

  it("does not aim for the left button or a three-finger swipe", () => {
    const onAim = vi.fn();
    const g = createSwapGestures(vi.fn(), vi.fn(), onAim);
    g.pointerDown({ ...at(100, 300), button: 0, target }, boundary);
    g.touchStart({ touches: [at(100, 300), at(120, 300), at(140, 300)], target }, boundary);
    g.touchMove({ touches: [at(100, 200), at(120, 200), at(140, 200)] });
    g.touchEnd({ changedTouches: [at(100, 200)] });
    expect(onAim).not.toHaveBeenCalled();
  });
});
