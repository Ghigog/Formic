import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { ColonyProvider, crewPhase } from "./colony";
import { SoundEngine } from "./sound";
import { makeCard } from "@/test/cards";

afterEach(() => {
  vi.restoreAllMocks();
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
});
