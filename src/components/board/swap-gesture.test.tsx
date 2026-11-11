import { describe, expect, it, vi } from "vitest";
import { classifyTwoFingerTravel, createSwapGestures, MAX_PULL, pullFor } from "./swap-gesture";

const boundary = document.createElement("div");
const target = document.createElement("div");
boundary.append(target);
const at = (x: number, y: number) => ({ clientX: x, clientY: y });

function setup() {
  const onSwap = vi.fn();
  return { onSwap, g: createSwapGestures(onSwap) };
}

const two = (y: number, x = 100) => [at(x, y), at(x + 40, y)];
const three = (y: number) => [at(100, y), at(120, y), at(140, y)];

/** Two fingers down at y=300, moved to `to` in a few steps, then lifted. */
function swipe(g: ReturnType<typeof createSwapGestures>, to: number) {
  g.touchStart({ touches: two(300), target }, boundary);
  g.touchMove({ touches: two((300 + to) / 2) });
  g.touchMove({ touches: two(to) });
  g.touchEnd();
}

describe("two-finger swipe", () => {
  it("requests a down swap for an upward swipe past the threshold", () => {
    const { g, onSwap } = setup();
    swipe(g, 200);
    expect(onSwap).toHaveBeenCalledWith("down");
  });

  it("requests an up swap for a downward swipe", () => {
    const { g, onSwap } = setup();
    swipe(g, 400);
    expect(onSwap).toHaveBeenCalledWith("up");
  });

  it("ignores one-finger swipes, sideways or vertical", () => {
    const { g, onSwap } = setup();
    g.touchStart({ touches: [at(300, 100)], target }, boundary);
    expect(g.touchMove({ touches: [at(100, 100)] })).toBe(false);
    g.touchEnd();
    g.touchStart({ touches: [at(0, 300)], target }, boundary);
    expect(g.touchMove({ touches: [at(0, 100)] })).toBe(false);
    g.touchEnd();
    expect(onSwap).not.toHaveBeenCalled();
  });

  it("ignores short and sideways two-finger travel", () => {
    const { g, onSwap } = setup();
    swipe(g, 280);
    g.touchStart({ touches: two(300), target }, boundary);
    g.touchMove({ touches: two(200, 300) });
    g.touchEnd();
    expect(onSwap).not.toHaveBeenCalled();
  });

  it("never swaps with three fingers", () => {
    const { g, onSwap } = setup();
    g.touchStart({ touches: three(300), target }, boundary);
    expect(g.touchMove({ touches: three(200) })).toBe(false);
    g.touchEnd();
    // A third finger joining two that were already down ends the swipe.
    g.touchStart({ touches: two(300), target }, boundary);
    g.touchStart({ touches: three(300), target }, boundary);
    expect(g.touchMove({ touches: three(200) })).toBe(false);
    g.touchEnd();
    expect(onSwap).not.toHaveBeenCalled();
  });

  it("never swaps on a pinch, and does not claim it", () => {
    const onSwap = vi.fn();
    const onPull = vi.fn();
    const g = createSwapGestures(onSwap, onPull);
    g.touchStart({ touches: [at(100, 300), at(140, 300)], target }, boundary);
    expect(g.touchMove({ touches: [at(60, 300), at(180, 300)] })).toBe(false);
    // Spreading while drifting up is still a pinch.
    expect(g.touchMove({ touches: [at(40, 200), at(200, 280)] })).toBe(false);
    g.touchEnd();
    expect(onPull).not.toHaveBeenCalled();
    expect(onSwap).not.toHaveBeenCalled();
  });

  it("ignores gestures that start in something that owns them", () => {
    const { g, onSwap } = setup();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    boundary.append(dialog);
    g.touchStart({ touches: two(300), target: dialog }, boundary);
    expect(g.touchMove({ touches: two(100) })).toBe(false);
    g.touchEnd();
    dialog.remove();
    expect(onSwap).not.toHaveBeenCalled();
  });
});

describe("classifyTwoFingerTravel", () => {
  const start = [at(100, 300), at(140, 300)] as const;
  it("is pending until the fingers have travelled", () => {
    expect(classifyTwoFingerTravel(start, [at(100, 295), at(140, 295)])).toBe("pending");
  });
  it("calls parallel vertical travel a swipe, either way", () => {
    expect(classifyTwoFingerTravel(start, [at(102, 250), at(142, 252)])).toBe("swipe");
    expect(classifyTwoFingerTravel(start, [at(100, 350), at(140, 350)])).toBe("swipe");
  });
  it("calls a change in the distance between them a pinch", () => {
    expect(classifyTwoFingerTravel(start, [at(70, 300), at(170, 300)])).toBe("pinch");
    expect(classifyTwoFingerTravel(start, [at(100, 290), at(140, 340)])).toBe("pinch");
  });
  it("does not call sideways travel a swipe", () => {
    expect(classifyTwoFingerTravel(start, [at(200, 280), at(240, 280)])).toBe("pending");
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
  it("reports a two-finger swipe's travel as it goes, with resistance, and lets go at the end", () => {
    const onSwap = vi.fn();
    const onPull = vi.fn();
    const g = createSwapGestures(onSwap, onPull);
    g.touchStart({ touches: two(300), target }, boundary);
    expect(g.touchMove({ touches: two(260) })).toBe(true);
    const pulled = onPull.mock.calls.at(-1)![0] as number;
    expect(pulled).toBeLessThan(0);
    expect(pulled).toBeGreaterThan(-40);
    g.touchMove({ touches: two(200) });
    g.touchEnd();
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

  it("aims a two-finger swipe at one threshold in its direction, armed once it has travelled that far", () => {
    const onAim = vi.fn();
    const g = createSwapGestures(vi.fn(), vi.fn(), onAim);
    g.touchStart({ touches: two(300), target }, boundary);
    g.touchMove({ touches: two(270) });
    expect(onAim).toHaveBeenLastCalledWith({ x: 120, y: 240, armed: false, touch: true });
    g.touchMove({ touches: two(235) });
    expect(onAim).toHaveBeenLastCalledWith({ x: 120, y: 240, armed: true, touch: true });
    g.touchEnd();
    expect(onAim).toHaveBeenLastCalledWith(null);
  });

  it("aims below the fingers when they swipe down", () => {
    const onAim = vi.fn();
    const g = createSwapGestures(vi.fn(), vi.fn(), onAim);
    g.touchStart({ touches: two(300), target }, boundary);
    g.touchMove({ touches: two(340) });
    expect(onAim).toHaveBeenLastCalledWith({ x: 120, y: 360, armed: false, touch: true });
  });

  it("takes the aim away on a cancel, a lost finger or a pinch", () => {
    for (const end of [
      (g: ReturnType<typeof createSwapGestures>) => g.touchCancel(),
      (g: ReturnType<typeof createSwapGestures>) => g.touchMove({ touches: [at(100, 250)] }),
      (g: ReturnType<typeof createSwapGestures>) => g.touchMove({ touches: [at(40, 250), at(200, 250)] }),
    ]) {
      const onAim = vi.fn();
      const onSwap = vi.fn();
      const g = createSwapGestures(onSwap, vi.fn(), onAim);
      g.touchStart({ touches: two(300), target }, boundary);
      g.touchMove({ touches: two(250) });
      end(g);
      g.touchEnd();
      expect(onAim).toHaveBeenLastCalledWith(null);
      expect(onSwap).not.toHaveBeenCalled();
    }
  });

  it("does not aim for the left button, three fingers or a one-finger swipe", () => {
    const onAim = vi.fn();
    const g = createSwapGestures(vi.fn(), vi.fn(), onAim);
    g.pointerDown({ ...at(100, 300), button: 0, target }, boundary);
    g.touchStart({ touches: three(300), target }, boundary);
    g.touchMove({ touches: three(200) });
    g.touchEnd();
    g.touchStart({ touches: [at(100, 300)], target }, boundary);
    g.touchMove({ touches: [at(100, 200)] });
    g.touchEnd();
    expect(onAim).not.toHaveBeenCalled();
  });
});
