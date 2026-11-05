import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { ColonyProvider, crewPhase, scoutCrews, levelUpText, featuresCrossed, useColony } from "./colony";
import { endTour, activeTour, forgetTours } from "@/components/onboarding/store";
import { SENTINEL_UNLOCKS, pointsOf, scoreOf } from "@/lib/colony/game";
import { SoundEngine } from "./sound";
import { makeCard, makeEpicWithChildren } from "@/test/cards";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Fake timers for the waits below; animation frames stay real so flushFrame still settles. */
function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

async function flushFrame() {
  await act(async () => {
    await new Promise(requestAnimationFrame);
  });
}

describe("ColonyProvider agent-finished cue", () => {
  it("plays a cue when the Architect Agent clears workingSince on a To Do card", async () => {
    const play = vi.spyOn(SoundEngine.prototype, "play");
    const working = makeCard({ status: "ready", workingSince: "2024-01-01T00:00:00.000Z" });

    const { rerender } = render(
      <ColonyProvider storageKey="colony-test-agent-finished" cards={[working]} extras={{}}>
        <div data-tid={working.id} />
      </ColonyProvider>,
    );
    await flushFrame();

    // The Architect Agent finishes: workingSince clears, status stays "ready".
    rerender(
      <ColonyProvider storageKey="colony-test-agent-finished" cards={[{ ...working, workingSince: null }]} extras={{}}>
        <div data-tid={working.id} />
      </ColonyProvider>,
    );
    await flushFrame();

    expect(play).toHaveBeenCalledWith("reveal", 0);
  });
});

describe("ColonyProvider sound preference", () => {
  afterEach(() => window.localStorage.clear());

  it("mutes the engine when the browser-wide preference is off", async () => {
    window.localStorage.setItem("formic:sound", "off");
    const setEnabled = vi.spyOn(SoundEngine.prototype, "setEnabled");
    render(
      <ColonyProvider storageKey="colony-test-sound-off" cards={[]} extras={{}}>
        <div />
      </ColonyProvider>,
    );
    await flushFrame();
    expect(setEnabled).toHaveBeenLastCalledWith(false);
  });
});

describe("ColonyProvider bug squash", () => {
  async function moveToDone(title: string, workType?: "bug") {
    // Reduced motion: the squash lands at once, and jsdom needs no animations.
    fakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const play = vi.spyOn(SoundEngine.prototype, "play");
    const [epic, ticket] = makeEpicWithChildren({ title, workType }, [{ status: "review" }]);
    const tree = (cards: typeof ticket[]) => (
      <ColonyProvider storageKey={`colony-test-squash-${title}`} cards={cards as never} extras={{}}>
        <div data-tid={ticket!.id}>
          <span data-bugicon />
        </div>
      </ColonyProvider>
    );
    const { rerender } = render(tree([epic!, ticket!]));
    await flushFrame();
    rerender(tree([epic!, { ...ticket!, status: "merged" }]));
    await flushFrame();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    return play.mock.calls.filter(([name]) => name === "squash");
  }

  it("squashes a bug ticket once when it lands in Done", async () => {
    expect(await moveToDone("Fix the flickering board", "bug")).toHaveLength(1);
  });

  it("does not squash a ticket of a feature Epic", async () => {
    expect(await moveToDone("Add dark mode")).toHaveLength(0);
  });
});

describe("the done animation", () => {
  async function statusChanges(...statuses: Array<[string, number]>) {
    fakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const play = vi.spyOn(SoundEngine.prototype, "play");
    const dings = () => play.mock.calls.filter(([name]) => name === "ding").length;
    const card = makeCard({ status: "review", stage: 6, prNumber: 3 });
    const tree = (c: typeof card) => (
      <ColonyProvider storageKey="colony-test-done-anim" cards={[c] as never} extras={{}}>
        <div data-tid={card.id} />
      </ColonyProvider>
    );
    const { rerender } = render(tree(card));
    await flushFrame();
    const seen: number[] = [];
    for (const [status, stage] of statuses) {
      rerender(tree({ ...card, status: status as never, stage }));
      await flushFrame();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      seen.push(dings());
    }
    return seen;
  }

  it("plays only once the ticket becomes merged, not while it waits in Merging", async () => {
    const [merging, merged] = await statusChanges(["review", 7], ["merged", 8]);
    expect(merging).toBe(0);
    expect(merged).toBeGreaterThan(0);
  });

  it("does not play when a merge fails", async () => {
    const [failed] = await statusChanges(["blocked", 6]);
    expect(failed).toBe(0);
  });
});

describe("crewPhase", () => {
  const since = "2024-01-01T00:00:00.000Z";

  it("sends a crew only to a running card an agent is really on", () => {
    expect(crewPhase(makeCard({ status: "running", workingSince: since }), {})).toBe("work");
    expect(crewPhase(makeCard({ status: "running", workingSince: null }), {})).toBeNull();
  });

  it("keeps a queue crew on a card that starts running before its run attaches", () => {
    const running = makeCard({ status: "running", workingSince: null });
    expect(crewPhase(running, {}, true)).toBe("work");
    expect(crewPhase(running, {}, false)).toBeNull();
  });

  it("tunnels in review while CI runs or the reviewer works, and rests otherwise", () => {
    const review = makeCard({ status: "review", prNumber: 1 });
    expect(crewPhase({ ...review, workingSince: since }, {})).toBe("tunnel");
    expect(crewPhase(review, { [review.id]: { ci: "pending" } })).toBe("tunnel");
    expect(crewPhase(review, { [review.id]: { ci: "passing" } })).toBe("buried");
    expect(crewPhase(review, { [review.id]: { ci: "failing" } })).toBeNull();
  });

  it("reads a To Do card whose agent is on its words, and leaves the rest of the column alone", () => {
    expect(crewPhase(makeCard({ status: "ready", workingSince: since }), {})).toBe("read");
    expect(crewPhase(makeCard({ status: "ready", workingSince: null }), {})).toBeNull();
    // Held by a dependency, so no agent is on it: no crew.
    expect(crewPhase(makeCard({ status: "waiting" }), {})).toBeNull();
  });

  it("counts a chat being answered as an agent on the card, in whatever column", () => {
    const todo = makeCard({ status: "ready", workingSince: null });
    expect(crewPhase(todo, { [todo.id]: { answering: true } })).toBe("read");
    const running = makeCard({ status: "running", workingSince: null });
    expect(crewPhase(running, { [running.id]: { answering: true } })).toBe("work");
    // The reply landed: nothing is being worked, so the crew goes home.
    expect(crewPhase(todo, { [todo.id]: { answering: false } })).toBeNull();
  });

  it("reads an Epic in To Do while the Architect breaks it down, and one in Backlog while its PRD is written", () => {
    const todo = makeCard({ kind: "epic", status: "ready", childCount: 4 });
    expect(crewPhase({ ...todo, workingSince: since }, {})).toBe("read");
    expect(crewPhase(todo, { [todo.id]: { answering: true } })).toBe("read");
    // Nobody on it: the Epics in the column stay still.
    expect(crewPhase(todo, {})).toBeNull();

    const backlog = makeCard({ kind: "epic", status: "draft" });
    expect(crewPhase({ ...backlog, workingSince: since }, {})).toBe("read");
    expect(crewPhase(backlog, { [backlog.id]: { answering: true } })).toBe("read");
    expect(crewPhase(backlog, {})).toBeNull();
  });

  it("leaves a merged Epic alone, whoever is talking about it", () => {
    const done = makeCard({ kind: "epic", status: "merged" });
    expect(crewPhase(done, { [done.id]: { answering: true } })).toBeNull();
  });
});

describe("levelUpText", () => {
  it("names the Sentinel a level unlocks and the Queen", () => {
    const text = levelUpText(SENTINEL_UNLOCKS[0]!.lv);
    expect(text).toContain(SENTINEL_UNLOCKS[0]!.label);
    expect(text).toContain("Queen");
  });
});

describe("scoutCrews", () => {
  const since = new Date().toISOString();
  const running = (o: object) => makeCard({ status: "running", workingSince: since, ...o } as never);

  it("adds a half-size crew per scout out on a running card", () => {
    const card = running({ scouts: 2, storyPoints: 5 });
    const crews = scoutCrews(card);
    expect([...crews.keys()]).toEqual([`${card.id}#scout1`, `${card.id}#scout2`]);
    for (const c of crews.values()) expect(c).toEqual({ phase: "work", sp: pointsOf(card) / 2 });
  });

  it("rounds to at least one ant", () => {
    const card = running({ scouts: 1, storyPoints: 1 });
    expect([...scoutCrews(card).values()][0]!.sp).toBe(0.5);
  });

  it("adds none when not running, with a pick, or with no scouts", () => {
    expect(scoutCrews(makeCard({ status: "review", scouts: 2 } as never)).size).toBe(0);
    expect(scoutCrews(running({ scouts: 2, scoutPick: "x" })).size).toBe(0);
    expect(scoutCrews(running({ scouts: 0 })).size).toBe(0);
  });
});

describe("ColonyProvider featureUnlocked", () => {
  const boardAt = (level: number) => {
    const cards = [];
    while (scoreOf(cards).level < level) {
      cards.push(makeCard({ status: "merged", mergedAt: "2020-01-01T00:00:00.000Z" }));
    }
    return cards;
  };

  function Probe() {
    const c = useColony();
    return (
      <div data-testid="probe">
        {(["sentinels", "timeline"] as const).map((f) => `${f}:${c?.featureUnlocked(f)}`).join(" ")}
      </div>
    );
  }

  const probe = (level: number, unlockAll = false) => {
    const { getByTestId } = render(
      <ColonyProvider storageKey={`colony-test-features-${level}-${unlockAll}`} cards={boardAt(level)} extras={{}} unlockAll={unlockAll}>
        <Probe />
      </ColonyProvider>,
    );
    return getByTestId("probe").textContent;
  };

  it("hides Sentinels and Timeline at Lv 1", () => {
    expect(probe(1)).toBe("sentinels:false timeline:false");
  });

  it("shows Sentinels but not Timeline at Lv 2", () => {
    expect(probe(2)).toBe("sentinels:true timeline:false");
  });

  it("shows both at Lv 10", () => {
    expect(probe(10)).toBe("sentinels:true timeline:true");
  });

  it("shows Sentinels at once on a Lv 1 board with Unlock all on, but not Timeline", () => {
    expect(probe(1, true)).toBe("sentinels:true timeline:false");
  });
});

describe("feature reveal queue", () => {
  it("lists the features a rise crosses in level order", () => {
    expect(featuresCrossed(9, 15)).toEqual(["timeline", "calls"]);
    expect(featuresCrossed(1, 25)).toEqual(["sentinels", "timeline", "calls", "kpis"]);
    expect(featuresCrossed(10, 14)).toEqual([]);
  });

  it("names the feature in the level-up pill", () => {
    expect(levelUpText(10)).toMatch(/unlocked .*Timeline/);
    expect(levelUpText(15)).toContain("Calls");
  });

  const boardAt = (level: number) => {
    const cards = [];
    while (scoreOf(cards).level < level) {
      cards.push(makeCard({ status: "merged", mergedAt: "2020-01-01T00:00:00.000Z" }));
    }
    return cards;
  };

  it("hides crossed features until the pill is gone, then reveals and tours them one at a time", async () => {
    window.localStorage.clear();
    forgetTours();
    endTour();
    fakeTimers();
    let api!: NonNullable<ReturnType<typeof useColony>>;
    function Probe() {
      api = useColony()!;
      return null;
    }
    const tree = (level: number) => (
      <ColonyProvider storageKey="colony-test-reveal-queue" cards={boardAt(level)} extras={{}}>
        <Probe />
      </ColonyProvider>
    );
    const { rerender } = render(tree(9));
    expect(api.featureUnlocked("timeline")).toBe(false);
    rerender(tree(15));
    // Reached, but held back behind the pill.
    expect(api.featureUnlocked("timeline")).toBe(false);
    expect(api.featureUnlocked("calls")).toBe(false);
    expect(api.revealing).toBeNull();

    // The pill is left alone and times out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(380 + 3200 + 10);
    });
    expect(api.revealing).toBe("timeline");
    expect(api.featureUnlocked("timeline")).toBe(true);
    expect(api.featureUnlocked("calls")).toBe(false);

    act(() => api.settleReveal());
    expect(activeTour()).toBe("timeline-intro");
    expect(api.revealing).toBe("timeline");

    act(() => endTour());
    expect(api.revealing).toBe("calls");
    expect(api.featureUnlocked("calls")).toBe(true);
    act(() => api.settleReveal());
    expect(activeTour()).toBe("calls-intro");
    act(() => endTour());
    expect(api.revealing).toBeNull();
  });

  it("opens the Sentinels panel for KPIs", async () => {
    window.localStorage.clear();
    forgetTours();
    endTour();
    fakeTimers();
    let api!: NonNullable<ReturnType<typeof useColony>>;
    function Probe() {
      api = useColony()!;
      return null;
    }
    render(
      <ColonyProvider storageKey="colony-test-reveal-kpis" cards={boardAt(20)} extras={{}}>
        <Probe />
      </ColonyProvider>,
    );
    act(() => api.enqueueReveals(["kpis"]));
    expect(api.revealing).toBe("kpis");
    expect(api.sentinelsOpen).toBe(true);
    act(() => api.settleReveal());
    expect(activeTour()).toBe("kpis-intro");
    act(() => endTour());
    // Once per person: a second reveal does not tour again.
    act(() => api.enqueueReveals(["kpis"]));
    act(() => api.settleReveal());
    expect(activeTour()).toBeNull();
    expect(api.revealing).toBeNull();
  });
});
