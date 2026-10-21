import { afterEach, describe, expect, it, vi } from "vitest";
import type { BugShape } from "@/lib/colony/game";
import { ColonyFx, type CrewPhase, type FxWorld } from "./fx";
import { SoundEngine } from "./sound";

/** A 2D context that accepts every drawing call and keeps nothing. */
function blankContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  return new Proxy(
    {},
    { get: () => () => gradient, set: () => true },
  ) as unknown as CanvasRenderingContext2D;
}

function canvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

function box(
  el: HTMLElement,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect;
  document.body.append(el);
  return el;
}

function card(id: string, left: number, top: number) {
  const el = document.createElement("div");
  el.dataset.tid = id;
  const trail = document.createElement("canvas");
  trail.setAttribute("data-trail", "");
  el.append(trail);
  box(el, left, top, 240, 90);
  return el;
}

function anchor(name: string, left: number, top: number) {
  const el = document.createElement("div");
  el.dataset.colony = name;
  return box(el, left, top, 60, 30);
}

type Internals = {
  frame: (now: number) => void;
  crewMap: Map<string, unknown>;
};

describe("ColonyFx frames", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function world(
    phase: CrewPhase | null,
    shape: BugShape,
    ids: string[],
  ): FxWorld {
    return {
      crews: new Map(phase ? ids.map((id) => [id, { phase, sp: 8 }]) : []),
      level: 5,
      ants: "busy",
      full: true,
      bugShape: shape,
      bugHex: "#aa5522",
      covered: false,
    };
  }

  const SHAPES: BugShape[] = [
    "ant",
    "beetle",
    "ladybird",
    "caterpillar",
    "spider",
    "moth",
    "bumblebee",
    "stag",
    "mosquito",
  ];
  const MODES: Array<Pick<FxWorld, "ants" | "full">> = [
    { ants: "busy", full: true },
    { ants: "few", full: false },
  ];

  it.each(SHAPES.flatMap((shape) => MODES.map((m) => [shape, m] as const)))(
    "walks a %s crew through every phase of a card's life and clears it away (%o)",
    (shape, mode) => {
      const ctx = blankContext();
      const getContext = vi
        .spyOn(HTMLCanvasElement.prototype, "getContext")
        .mockReturnValue(ctx as never);
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
      const sound = new SoundEngine();
      vi.spyOn(sound, "play").mockImplementation(() => {});
      const fx = new ColonyFx(sound);
      const inner = fx as unknown as Internals;
      anchor("nest", 20, 20);
      anchor("score", 300, 10);
      const ids = ["a", "b", "c", "d"];
      ids.forEach((id, i) => card(id, 100 + i * 10, 150 + i * 120));
      const unmount = fx.mount(canvas(), canvas());
      let now = 0;
      const run = (frames: number) => {
        for (let i = 0; i < frames; i++) inner.frame((now += 16));
      };
      const phases: CrewPhase[] = [
        "buried",
        "work",
        "queue",
        "read",
        "tunnel",
        "work",
        "tunnel",
        "buried",
        "leave",
      ];
      phases.forEach((phase, i) => {
        fx.setWorld({
          ...world(phase, shape, ids),
          ...mode,
          crews: new Map(
            ids.map((id, j) => [
              id,
              {
                phase: j % 2 ? phase : phases[(i + 1) % phases.length]!,
                sp: 3 + j * 5,
              },
            ]),
          ),
        });
        run(120);
      });
      fx.burst(50, 50, ["var(--text)"], 12);
      fx.ring(50, 50, "var(--text)");
      fx.pop(50, 50, "+3", "sub", "var(--text)");
      fx.carriers(60, 60, 3, "#fff");
      fx.fly(10, 10, 300, 200, 4, "var(--text)", () => {});
      fx.squash(80, 80, () => {});
      fx.shake();
      run(300);
      fx.setWorld({ ...world(null, shape, ids), ...mode });
      run(1500);
      expect(getContext).toHaveBeenCalled();
      expect(inner.crewMap.size).toBe(0);
      unmount();
    },
  );

  it("draws nothing flashy and calls back at once when motion is reduced", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      blankContext() as never,
    );
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    const fx = new ColonyFx(new SoundEngine());
    const unmount = fx.mount(canvas());
    expect(fx.reducedMotion).toBe(true);
    const each = vi.fn();
    fx.fly(0, 0, 10, 10, 3, "var(--text)", each);
    expect(each).toHaveBeenCalledTimes(3);
    fx.burst(1, 1, ["var(--text)"], 5);
    fx.ring(1, 1, "var(--text)");
    fx.shake();
    unmount();
    vi.unstubAllGlobals();
  });
});
