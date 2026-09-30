import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { ColonyProvider, crewPhase } from "./colony";
import { SoundEngine } from "./sound";
import { makeCard, makeEpicWithChildren } from "@/test/cards";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

describe("ColonyProvider bug squash", () => {
  async function moveToDone(title: string) {
    // Reduced motion: the squash lands at once, and jsdom needs no animations.
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const play = vi.spyOn(SoundEngine.prototype, "play");
    const [epic, ticket] = makeEpicWithChildren({ title }, [{ status: "review" }]);
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
      await new Promise((r) => setTimeout(r, 1500));
    });
    return play.mock.calls.filter(([name]) => name === "squash");
  }

  it("squashes a bug ticket once when it lands in Done", async () => {
    expect(await moveToDone("Fix the flickering board")).toHaveLength(1);
  });

  it("does not squash a ticket of a feature Epic", async () => {
    expect(await moveToDone("Add dark mode")).toHaveLength(0);
  });
});

describe("crewPhase", () => {
  const since = "2024-01-01T00:00:00.000Z";

  it("sends a crew only to a running card an agent is really on", () => {
    expect(crewPhase(makeCard({ status: "running", workingSince: since }), {})).toBe("work");
    expect(crewPhase(makeCard({ status: "running", workingSince: null }), {})).toBeNull();
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
