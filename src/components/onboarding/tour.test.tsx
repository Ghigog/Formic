import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutoTour, Tour, TourHost } from "./tour";
import { endTour, hasSeen, offerTour, replayTours, startTour } from "./store";
import { TOURS, TOUR_COLUMN_EVENT, type TourDef } from "./tours";
import { AgentSelect } from "@/components/board/agent-select";
import { speaks, syllable } from "./voice";

/**
 * The guided tour: it finds what each step points at, talks about it, skips
 * what is not on screen, and remembers which tours this browser has seen.
 */

/** A tour target with a real-looking box: jsdom lays nothing out. */
function target(name: string, box = { x: 100, y: 100, w: 200, h: 80 }) {
  const el = document.createElement("div");
  el.setAttribute("data-tour", name);
  el.getBoundingClientRect = () =>
    ({ left: box.x, top: box.y, width: box.w, height: box.h, right: box.x + box.w, bottom: box.y + box.h, x: box.x, y: box.y, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

/** Shown in the DOM but laid out at zero size, like a desktop control on a phone. */
function hiddenTarget(name: string) {
  const el = document.createElement("div");
  el.setAttribute("data-tour", name);
  document.body.appendChild(el);
  return el;
}

const def: TourDef = {
  id: "board",
  steps: [
    { target: "one", side: "below", title: "First", text: "The first thing." },
    { target: "phone-hidden", side: "below", title: "Hidden", text: "Not on this screen." },
    { target: "two", side: "right", title: "Second", text: "The second thing." },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  // Reduced motion: the ant jumps and each line appears whole, so a test
  // reads the bubble without waiting on the walk or the typing.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  window.localStorage.clear();
});

afterEach(() => {
  act(() => endTour());
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Time to reach the next step without waiting: less than the 1.8s a step waits for a target that has not rendered. */
const FIND_WAIT_UNDER = 1000;

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });

describe("Tour", () => {
  it.each([
    [true, "Swipe up with two fingers"],
    [false, "Hold the right mouse button"],
  ])("says the touch line only on a coarse pointer (%s)", async (coarse, line) => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") || (coarse && q.includes("coarse")), addEventListener() {}, removeEventListener() {} }));
    target("column");
    render(<Tour def={TOURS["swap-intro"]} onEnd={() => {}} />);
    await flush();
    expect(screen.getByText(new RegExp(line))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Got it" })).toBeTruthy();
  });

  it("talks about each step in turn, leaving out and not counting one whose target is hidden", async () => {
    target("one");
    hiddenTarget("phone-hidden");
    target("two");
    const onEnd = vi.fn();
    render(<Tour def={def} onEnd={onEnd} />);
    await flush();

    expect(screen.getByRole("dialog", { name: "Tour: First" })).toBeTruthy();
    expect(screen.getByText("The first thing.")).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Tour: Second" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("asks the board for a step's column, and hands it back when the target never turns up", async () => {
    const asked: Array<string | null> = [];
    // A phone's board: it brings the column up, but the card is not there.
    const listen = (e: Event) => {
      const detail = (e as CustomEvent<{ column: string | null; shown?: boolean }>).detail;
      asked.push(detail.column);
      if (detail.column) detail.shown = true;
    };
    window.addEventListener(TOUR_COLUMN_EVENT, listen);
    const phoneDef: TourDef = {
      id: "board",
      steps: [{ target: "later", column: "todo", side: "right", title: "Ticket", text: "In To Do." }],
    };
    render(<Tour def={phoneDef} onEnd={() => {}} />);
    await flush();
    window.removeEventListener(TOUR_COLUMN_EVENT, listen);
    expect(asked).toEqual(["todo", null]);
  });

  it("keeps the column it asked for when the target turns up there", async () => {
    const asked: Array<string | null> = [];
    // The board answers by rendering the column: here, the target appears.
    const listen = (e: Event) => {
      const detail = (e as CustomEvent<{ column: string | null; shown?: boolean }>).detail;
      asked.push(detail.column);
      if (detail.column) {
        detail.shown = true;
        target("later");
      }
    };
    window.addEventListener(TOUR_COLUMN_EVENT, listen);
    const phoneDef: TourDef = {
      id: "board",
      steps: [{ target: "later", column: "todo", side: "right", title: "Ticket", text: "In To Do." }],
    };
    render(<Tour def={phoneDef} onEnd={() => {}} />);
    await flush();
    window.removeEventListener(TOUR_COLUMN_EVENT, listen);
    expect(asked).toEqual(["todo"]);
    expect(screen.getByRole("dialog", { name: "Tour: Ticket" })).toBeTruthy();
  });

  describe("in a tour of what is already on screen, like the board's", () => {
    const allThere: TourDef = {
      id: "board",
      allThere: true,
      steps: [
        { target: "one", side: "below", title: "First", text: "The first thing." },
        { target: "later", column: "todo", side: "right", title: "Ticket", text: "In To Do." },
        { target: "two", side: "right", title: "Second", text: "The second thing." },
      ],
    };

    it("keeps a step whose column a phone is not showing, and shows it once the board brings the column up", async () => {
      target("one");
      target("two");
      const listen = (e: Event) => {
        const detail = (e as CustomEvent<{ column: string | null; shown?: boolean }>).detail;
        if (detail.column) {
          detail.shown = true;
          target("later");
        }
      };
      window.addEventListener(TOUR_COLUMN_EVENT, listen);
      render(<Tour def={allThere} onEnd={() => {}} />);
      await flush();
      expect(screen.getByText("1 / 3")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await flush();
      window.removeEventListener(TOUR_COLUMN_EVENT, listen);
      expect(screen.getByRole("dialog", { name: "Tour: Ticket" })).toBeTruthy();
    });

    it("moves straight on when no board brings the column up (every column already shows)", async () => {
      target("one");
      target("two");
      render(<Tour def={allThere} onEnd={() => {}} />);
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      // No waiting for a card that is not there: well under the find timeout.
      // In small ticks, so React runs its effects between the tour's timers.
      for (let t = 0; t < FIND_WAIT_UNDER; t += 100) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      }
      expect(screen.getByRole("dialog", { name: "Tour: Second" })).toBeTruthy();
    });
  });

  it("does not ask for a column when the target is already on screen", async () => {
    const asked: string[] = [];
    const listen = () => asked.push("asked");
    window.addEventListener(TOUR_COLUMN_EVENT, listen);
    target("later");
    const phoneDef: TourDef = {
      id: "board",
      steps: [{ target: "later", column: "todo", side: "right", title: "Ticket", text: "In To Do." }],
    };
    render(<Tour def={phoneDef} onEnd={() => {}} />);
    await flush();
    window.removeEventListener(TOUR_COLUMN_EVENT, listen);
    expect(asked).toEqual([]);
  });

  it("goes back a step", async () => {
    target("one");
    target("phone-hidden");
    render(<Tour def={def} onEnd={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(screen.getByText("Not on this screen.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await flush();
    expect(screen.getByText("The first thing.")).toBeTruthy();
  });

  it("goes back past a step that never turned up, instead of bouncing forward", async () => {
    target("one");
    target("two");
    // "phone-hidden" is not in the page at all: it is waited for, then dropped.
    render(<Tour def={def} onEnd={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    await flush();
    expect(screen.getByText("The second thing.")).toBeTruthy();
    expect(screen.getByText("2 / 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await flush();
    expect(screen.getByText("The first thing.")).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();
  });

  it("moves one step for a double click on Next", async () => {
    target("one");
    target("phone-hidden");
    target("two");
    render(<Tour def={def} onEnd={() => {}} />);
    await flush();
    const next = screen.getByRole("button", { name: "Next" });
    fireEvent.click(next);
    fireEvent.click(next);
    await flush();
    expect(screen.getByText("Not on this screen.")).toBeTruthy();
  });

  it("ends on Skip and on Escape", async () => {
    target("one");
    const onEnd = vi.fn();
    render(<Tour def={def} onEnd={onEnd} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("waits for the person to act on a waiting step, with no Next button", async () => {
    target("login");
    render(
      <Tour
        def={{ id: "login", steps: [{ target: "login", side: "left", title: "Welcome", text: "Sign in.", waitFor: "Sign in to carry on" }] }}
        onEnd={() => {}}
      />,
    );
    await flush();
    expect(screen.getByText("Sign in to carry on")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("walks into the nest at the end of a tour that ends there", async () => {
    target("one");
    target("colony", { x: 1300, y: 860, w: 40, h: 36 });
    const onEnd = vi.fn();
    render(<Tour def={{ id: "board", endInNest: true, steps: [def.steps[0]!] }} onEnd={onEnd} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("mutes the ant without touching anything else", async () => {
    target("one");
    render(<Tour def={def} onEnd={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Mute the ant" }));
    expect(window.localStorage.getItem("formic:tours:voice")).toBe("off");
    expect(screen.getByRole("button", { name: "Let the ant talk" })).toBeTruthy();
  });
});

describe("AutoTour and the host", () => {
  it("plays a screen's tour the first time only", async () => {
    target("examples");
    const { unmount } = render(
      <>
        <TourHost />
        <AutoTour id="pick" delay={0} />
      </>,
    );
    await flush();
    expect(screen.getByRole("dialog", { name: "Tour: Pick a project" })).toBeTruthy();
    expect(hasSeen("pick")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    unmount();
    render(
      <>
        <TourHost />
        <AutoTour id="pick" delay={0} />
      </>,
    );
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits while another tour runs", async () => {
    target("examples");
    act(() => startTour("timeline"));
    render(<AutoTour id="pick" delay={0} />);
    await flush();
    expect(hasSeen("pick")).toBe(false);
  });

  it("replays from the board, and asks to go there from anywhere else", () => {
    window.localStorage.setItem("formic:tours:seen", JSON.stringify(["board", "timeline"]));
    expect(replayTours()).toBe(false);
    expect(hasSeen("timeline")).toBe(false);

    target("column");
    expect(replayTours()).toBe(true);
    expect(hasSeen("board")).toBe(true);
  });
});

describe("the ant's voice", () => {
  it("mutters every third letter, never on spaces or punctuation", () => {
    expect(speaks("a", 3)).toBe(true);
    expect(speaks("a", 4)).toBe(false);
    expect(speaks(" ", 3)).toBe(false);
    expect(speaks(",", 6)).toBe(false);
  });

  it("gives the same letter the same syllable", () => {
    expect(syllable("k")).toEqual(syllable("K"));
    expect(syllable("a").freq).toBeGreaterThan(0);
  });
});

describe("the agent drop-down's tour", () => {
  const menu = () => (
    <>
      <TourHost />
      <AgentSelect slot="todo" presets={[]} selected={undefined} onAssign={async () => {}} onEdit={() => {}} />
    </>
  );
  const open = async () => {
    fireEvent.click(screen.getByRole("button", { name: /Agent for/ }));
    await flush();
  };

  it("explains no agent, picking one and the key, the first time it opens", async () => {
    for (const name of ["agent-menu-none", "agent-menu-agents", "agent-menu-key"]) target(name);
    render(menu());
    await open();
    expect(screen.getByRole("dialog", { name: "Tour: No agent" }).textContent).toContain("by hand");
    fireEvent.mouseDown(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Tour: Pick an agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Tour: A key" }).textContent).toContain("Settings");
  });

  it("does not run again once seen", async () => {
    window.localStorage.setItem("formic:tours:seen", JSON.stringify(["agent-menu"]));
    render(menu());
    await open();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the board tour", () => {
  it("says columns start with no agent", () => {
    const step = TOURS.board.steps.find((s) => s.title === "Column agents");
    expect(step?.text).toContain("start with no agent");
  });
});

describe("the board tour on a Lv 1 board", () => {
  it("says nothing of Sentinels, Timeline, Calls or KPIs", () => {
    for (const step of TOURS.board.steps) {
      expect(`${step.target} ${step.title} ${step.text}`).not.toMatch(/sentinel|timeline|calls|kpi/i);
    }
  });
});

describe("feature intro tours", () => {
  const intros = ["sentinels-intro", "timeline-intro", "kpis-intro"] as const;

  it("starts on the feature's button and ends in the nest", () => {
    expect(TOURS["timeline-intro"].steps[0]!.target).toBe("timeline");
    for (const id of intros) expect(TOURS[id].endInNest).toBe(true);
  });

  it("plays once per person, whichever board reaches the level", () => {
    for (const id of intros) {
      expect(offerTour(id)).toBe(true);
      endTour();
      // A second board reaching the same level offers it again.
      expect(offerTour(id)).toBe(false);
    }
  });
});
