import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { BoardCard } from "@/lib/domain/entities";
import { ColonyProvider, useColony, type ColonyApi } from "./colony";
import { SoundEngine } from "./sound";
import { makeCard, makeEpicWithChildren } from "@/test/cards";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function rect(el: Element, left: number, top: number, width = 200, height = 80) {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
}

/** The cards and header anchors, laid out so every reaction finds somewhere to land. */
function Board({ cards, onApi }: { cards: BoardCard[]; onApi: (api: ColonyApi) => void }) {
  const api = useColony()!;
  onApi(api);
  return (
    <>
      {["score", "heat", "timeline", "nest", "board", "level"].map((name) => (
        <div key={name} data-colony={name} ref={(e) => void (e && rect(e, 10, 10, 60, 30))} />
      ))}
      {cards.map((c, i) => (
        <div key={c.id} data-tid={c.id} ref={(e) => void (e && rect(e, 100, 100 + i * 100))}>
          <span data-bugicon />
        </div>
      ))}
    </>
  );
}

async function settle(ms = 2000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("ColonyProvider reactions", () => {
  it("reacts to cards changing state, and refuses locked styles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Element.prototype.animate = vi.fn() as never;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const play = vi.spyOn(SoundEngine.prototype, "play").mockImplementation(() => {});
    let api!: ColonyApi;

    const [epic, a, b, c, d] = makeEpicWithChildren({ status: "ready" }, [
      { status: "waiting" },
      { status: "ready" },
      { status: "ready" },
      { status: "review", prNumber: 5, stage: 6 },
    ]);
    const lone = makeCard({ status: "draft" });
    const specEpic = makeCard({ kind: "epic", status: "draft", size: null });
    let extras: Record<string, { ci?: "passing" | "failing" | "pending" }> = { [d!.id]: { ci: "pending" } };
    const tree = (cards: BoardCard[]) => (
      <ColonyProvider storageKey="colony-test-reactions" cards={cards} extras={extras as never}>
        <Board cards={cards} onApi={(x) => (api = x)} />
      </ColonyProvider>
    );

    const first = [epic!, a!, b!, c!, d!, lone!, specEpic!];
    const { rerender } = render(tree(first));
    await settle(100);

    const step = async (cards: BoardCard[]) => {
      rerender(tree(cards));
      await settle();
    };
    // unlock, dispatch, queue, review->failed, new bug report, PRD drafted
    const bug = makeCard({ status: "draft", workType: "bug" } as never);
    await step([
      epic!,
      { ...a!, status: "ready" },
      { ...b!, status: "running", workingSince: "2024-01-01T00:00:00.000Z", model: "sonnet" },
      { ...c!, status: "queued" },
      { ...d!, status: "failed", blockedReason: "CI broke\nmore" },
      { ...lone!, status: "blocked" },
      { ...specEpic!, status: "specified" },
      bug,
    ]);
    extras = { [d!.id]: { ci: "failing" } };
    await step([epic!, a!, { ...b!, status: "review", prNumber: 9 }, { ...c!, status: "running" }, d!, lone!, specEpic!, bug]);
    extras = { [d!.id]: { ci: "passing" } };
    await step([epic!, a!, { ...b!, status: "review", prNumber: 9 }, { ...c!, status: "running" }, d!, lone!, specEpic!, bug]);
    // bug report handed to the agents, a ticket merged, then the epic
    await step([
      epic!,
      { ...a!, status: "merged", mergeMultiplier: 1.5 } as BoardCard,
      { ...b!, status: "merged" },
      { ...c!, status: "review", prNumber: 2 },
      d!,
      lone!,
      specEpic!,
      { ...bug, status: "ready" },
    ]);
    await step([{ ...epic!, status: "merged" }, { ...a!, status: "merged" }, { ...b!, status: "merged" }, c!, d!, lone!, specEpic!, bug]);
    await settle(5000);

    const names = play.mock.calls.map(([n]) => n);
    for (const n of ["unlock", "mint", "reject", "bad", "green", "ding"]) expect(names).toContain(n);

    // A style above the level is refused; one at it is equipped.
    const btn = document.createElement("button");
    rect(btn, 5, 5, 30, 30);
    document.body.append(btn);
    play.mockClear();
    act(() => api.tryStyle({ shape: "mosquito" }, btn));
    expect(play).toHaveBeenCalledWith("reject", 0);
    act(() => api.tryStyle({ shape: "ant" }, btn));
    await settle(200);
    expect(api.shape).toBe("ant");

    // Rejections and panels.
    act(() => api.reject(a!.id, "No"));
    act(() => api.reject("missing", "No"));
    act(() => api.setTimelineOpen(true));
    act(() => api.setSentinelsOpen(true));
    act(() => api.setColonyOpen(true));
    act(() => api.setTimelineOpen(false));
    expect(api.sentinelsOpen).toBe(true);
    act(() => api.setSentinelsOpen(false));
    act(() => api.setColonyOpen(false));
  });
});
