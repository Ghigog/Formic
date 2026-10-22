import { afterEach, describe, expect, it, vi } from "vitest";
import type { ColonyApi } from "@/components/colony/colony";

let colonyApi: ColonyApi | null = null;
vi.mock("@/components/colony/colony", async (orig) => ({
  ...(await orig<typeof import("@/components/colony/colony")>()),
  useColony: () => colonyApi,
}));
afterEach(() => {
  colonyApi = null;
});
import { DragDropContext } from "@hello-pangea/dnd";
import { fireEvent, render, screen } from "@testing-library/react";
import { Column } from "./column";
import { EMPTY_VIEW } from "./view";
import { CardEnvContext, type CardExtras } from "./card";
import { renderInDnd } from "@/test/render";
import { makeCard } from "@/test/cards";
import type { BoardCard } from "@/lib/domain/entities";

function renderReview(
  card: BoardCard,
  repo: { noCi?: boolean; autoMerge?: boolean } = {},
  extras: CardExtras = {},
) {
  const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn(), ...repo };
  return renderInDnd(
    <CardEnvContext.Provider value={env}>
      <Column id="in_review" cards={[card]} extras={{ [card.id]: extras }} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
    </CardEnvContext.Provider>,
  );
}

describe("a card in review", () => {
  it("shows a jade Ready to merge chip once it waits in the merge stage", () => {
    renderReview(makeCard({ status: "review", stage: 7, prNumber: 4 }));
    const chip = screen.getByText("Ready to merge");
    expect(chip.querySelector("span")?.className).toContain("bg-jade");
  });

  it("shows no Ready to merge chip before the merge stage", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }));
    expect(screen.queryByText("Ready to merge")).toBeNull();
  });

  it("says CI is running only when a pending report says so", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }), {}, { ci: "pending" });
    expect(screen.getByText("CI running")).toBeTruthy();
  });

  it("does not claim CI is running when it does not know", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }));
    expect(screen.queryByText("CI running")).toBeNull();
    expect(screen.getByText("CI status unknown")).toBeTruthy();
  });

  it("shows Checks passed and Ready to merge at the merge stage with no CI detail", () => {
    renderReview(makeCard({ status: "review", stage: 7, prNumber: 4 }));
    expect(screen.queryByText("CI running")).toBeNull();
    expect(screen.getByText("Checks passed")).toBeTruthy();
    expect(screen.getByText("Ready to merge")).toBeTruthy();
  });

  it("shows Checks failed when a failing report arrives", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }), {}, { ci: "failing" });
    expect(screen.getByText("Checks failed")).toBeTruthy();
  });

  it("shows Checks passed and Waiting for review once green before the merge stage", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }), {}, { ci: "passing" });
    expect(screen.getByText("Checks passed")).toBeTruthy();
    expect(screen.getByText("Waiting for review")).toBeTruthy();
  });

  it("leaves Waiting for review to the reviewer's own chip while it works", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }), {}, { ci: "passing", reviewState: "Reviewing" });
    expect(screen.queryByText("Waiting for review")).toBeNull();
    expect(screen.getByText("Reviewing")).toBeTruthy();
  });

  it("says a person merges on GitHub when auto-merge is off", () => {
    renderReview(makeCard({ status: "review", stage: 7, prNumber: 4 }), { autoMerge: false });
    expect(screen.getByText("Waiting for you to merge on GitHub")).toBeTruthy();
  });

  it("says there is no CI and that a person merges it, with auto-merge off", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }), { noCi: true, autoMerge: false });
    expect(screen.queryByText("CI running")).toBeNull();
    expect(screen.getByText("No CI · please merge manually")).toBeTruthy();
  });

  it("says there is no CI and that it is merging, with auto-merge on", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }), { noCi: true, autoMerge: true });
    expect(screen.getByText("No CI · auto-merging…")).toBeTruthy();
  });

  it("shows why a merge failed", () => {
    renderReview(
      makeCard({
        status: "blocked",
        stalledIn: "in_review",
        stage: 6,
        prNumber: 4,
        blockedReason: "Required review missing.",
      }),
    );
    expect(screen.getByTestId("card-problem").textContent).toContain("Required review missing.");
  });
});

describe("a ticket card's head", () => {
  it("keeps the tags out of the key row and puts them in a wrapping row beneath it", () => {
    const card = makeCard({ status: "merged", stage: 8, prNumber: 4, workType: "user_story", storyPoints: 5 });
    renderReview(card);
    const keyRow = screen.getByText(card.key).parentElement!;
    expect(keyRow.querySelector("[data-type-tag]")).toBeNull();
    expect(keyRow.querySelector("[data-sp]")).toBeNull();
    const tags = screen.getByTestId("card-tags");
    expect(tags.className).toContain("flex-wrap");
    expect(tags.querySelector("[data-type-tag]")).not.toBeNull();
    expect(tags.querySelector("[data-sp]")).not.toBeNull();
    expect(keyRow.nextElementSibling).toBe(tags);
  });

  it("shows no Pull request badge in the head", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }));
    expect(screen.queryByTitle("Pull request")).toBeNull();
    expect(screen.queryByText("PR #4")).toBeNull();
  });
});

describe("the queen mark", () => {
  it("shows on a card with a Queen and not on one without", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4, queen: true }));
    expect(screen.getByLabelText("Queen placed")).toBeTruthy();
  });

  it("is absent without a Queen", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }));
    expect(screen.queryByLabelText("Queen placed")).toBeNull();
  });

  function withColony(reducedMotion: boolean) {
    const sfx = vi.fn();
    const finish: { run?: () => void } = {};
    HTMLElement.prototype.animate = vi.fn(() => {
      const a = {} as { onfinish: (() => void) | null; cancel: () => void };
      a.cancel = () => {};
      Object.defineProperty(a, "onfinish", { set: (f) => (finish.run = f ?? undefined), get: () => finish.run });
      return a;
    }) as never;
    colonyApi = { sfx, fx: { reducedMotion } } as unknown as ColonyApi;
    return { sfx, finish };
  }

  function reviewTree(card: BoardCard) {
    const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn() };
    return (
      <DragDropContext onDragEnd={() => {}}>
        <CardEnvContext.Provider value={env}>
          <Column id="in_review" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
        </CardEnvContext.Provider>
      </DragDropContext>
    );
  }

  it("grows in with a hiss, then a pop, when a Queen is placed on a mounted card", () => {
    const { sfx, finish } = withColony(false);
    const card = makeCard({ status: "review", stage: 6, prNumber: 4 });
    const { rerender } = render(reviewTree(card));
    expect(sfx).not.toHaveBeenCalled();
    rerender(reviewTree({ ...card, queen: true }));
    expect(screen.getByLabelText("Queen placed")).toBeTruthy();
    expect(sfx).toHaveBeenCalledTimes(1);
    expect(sfx).toHaveBeenCalledWith("hiss");
    expect(HTMLElement.prototype.animate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 600 }));
    finish.run?.();
    expect(sfx).toHaveBeenLastCalledWith("pop");
  });

  it("skips the scale under reduced motion but keeps the sounds", () => {
    const { sfx } = withColony(true);
    const card = makeCard({ status: "review", stage: 6, prNumber: 4 });
    const { rerender } = render(reviewTree(card));
    rerender(reviewTree({ ...card, queen: true }));
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
    expect(sfx.mock.calls.map((c) => c[0])).toEqual(["hiss", "pop"]);
  });

  it("shows a Queen the card loaded with at once and silently", () => {
    const { sfx } = withColony(false);
    render(reviewTree(makeCard({ status: "review", stage: 6, prNumber: 4, queen: true })));
    expect(screen.getByLabelText("Queen placed")).toBeTruthy();
    expect(sfx).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
  });
});

describe("a notice on a card", () => {
  function renderTodo(card: BoardCard) {
    const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn() };
    return renderInDnd(
      <CardEnvContext.Provider value={env}>
        <Column id="todo" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
      </CardEnvContext.Provider>,
    );
  }

  const SCOPE = "Needs files outside its scope: src/a.ts\nlong detail";

  it("shows a red warning icon and the title only for a failed ticket", () => {
    renderTodo(makeCard({ status: "failed", stalledIn: "todo", blockedReason: "Boom\nstack trace" }));
    const notice = screen.getByTestId("card-notice");
    expect(notice.dataset.severity).toBe("warning");
    expect(notice.className).toContain("text-crimson");
    expect(notice.textContent).toContain("Failed");
    expect(screen.queryByText(/stack trace/)).toBeNull();
  });

  it("shows a yellow alert icon and the title only for a ticket paused for authorization", () => {
    renderTodo(makeCard({ status: "blocked", stalledIn: "todo", blockedReason: SCOPE }));
    const notice = screen.getByTestId("card-notice");
    expect(notice.dataset.severity).toBe("alert");
    expect(notice.className).toContain("text-clay");
    expect(notice.textContent).toContain("Needs authorization");
    expect(screen.queryByText(/long detail/)).toBeNull();
  });

  it("shows neither for a ticket waiting on a dependency", () => {
    renderTodo(makeCard({ status: "waiting", blockedReason: "Waiting on PROT-1" }));
    expect(screen.queryByTestId("card-notice")).toBeNull();
  });
});

describe("a card leaving its column", () => {
  function renderLeaving(direction: "forward" | "back", leavingId?: string) {
    const card = makeCard({ key: "PROT-01", status: "ready" });
    const onAdvance = vi.fn();
    const env = {
      epics: new Map(),
      nextFor: () => "in_progress" as const,
      onAdvance,
      leaving: { id: leavingId ?? card.id, direction },
    };
    renderInDnd(
      <CardEnvContext.Provider value={env}>
        <Column id="todo" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
      </CardEnvContext.Provider>,
    );
    return { onAdvance, arrow: screen.getByRole("button", { name: /^Move PROT-01/ }) };
  }

  it("slides right and fades going forward, left going back, on the inner wrapper", () => {
    const { arrow } = renderLeaving("forward");
    const li = arrow.closest("li")!;
    expect(li.firstElementChild).toHaveClass("translate-x-full", "opacity-0");
    expect(li).not.toHaveClass("translate-x-full");
  });

  it("slides left going back", () => {
    const { arrow } = renderLeaving("back");
    expect(arrow.closest("li")!.firstElementChild).toHaveClass("-translate-x-full");
  });

  it("ignores its arrow while leaving", () => {
    const { arrow, onAdvance } = renderLeaving("forward");
    fireEvent.click(arrow);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("stays put when another card is the one leaving", () => {
    const { arrow, onAdvance } = renderLeaving("forward", "other");
    expect(arrow.closest("li")!.firstElementChild).not.toHaveClass("opacity-0");
    fireEvent.click(arrow);
    expect(onAdvance).toHaveBeenCalledOnce();
  });
});

describe("a queued card", () => {
  function renderQueued(card: BoardCard) {
    const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn(), queuedBehind: () => null };
    return renderInDnd(
      <CardEnvContext.Provider value={env}>
        <Column id="in_progress" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
      </CardEnvContext.Provider>,
    );
  }

  it("names what it waits on from the server, even when nothing on this board holds it", () => {
    const reason = "Waiting for HER-1 on @alice's board, which is writing the same files. It starts on its own then.";
    const { container } = renderQueued(makeCard({ status: "queued", blockedReason: reason }));
    expect(container.querySelector("[data-queue]")?.getAttribute("aria-label")).toBe(reason);
  });
});

describe("a card whose move is pending", () => {
  it("hovers lifted, tilted and marked pending", () => {
    const card = makeCard({ key: "PROT-01", status: "ready" });
    const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn(), pending: new Set([card.id]) };
    renderInDnd(
      <CardEnvContext.Provider value={env}>
        <Column id="todo" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
      </CardEnvContext.Provider>,
    );
    const el = document.querySelector("li")!.firstElementChild!;
    expect(el).toHaveAttribute("data-pending");
    expect(el).toHaveClass("scale-[1.02]", "rotate-[-1deg]");
    expect(el).toHaveClass("motion-reduce:scale-100", "motion-reduce:rotate-0");
  });
});

describe("dragging a card", () => {
  function handle(pending: boolean) {
    const card = makeCard({ key: "PROT-02", status: "ready" });
    const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn(), pending: new Set(pending ? [card.id] : []) };
    renderInDnd(
      <CardEnvContext.Provider value={env}>
        <Column id="todo" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
      </CardEnvContext.Provider>,
    );
    return document.querySelector("li")!;
  }

  it("is locked while the move is pending", () => {
    const li = handle(true);
    expect(li.getAttribute("data-rfd-drag-handle-draggable-id")).toBeNull();
    expect(li).not.toHaveClass("cursor-grab");
  });

  it("works as before when nothing is pending", () => {
    const li = handle(false);
    expect(li.getAttribute("data-rfd-drag-handle-draggable-id")).not.toBeNull();
    expect(li).toHaveClass("cursor-grab");
  });
});

describe("a card's footer arrows", () => {
  function renderTodo(mobile: boolean, returnTo: "backlog" | null = "backlog") {
    const card = makeCard({ key: "PROT-02", status: "ready" });
    const env = {
      epics: new Map(),
      nextFor: () => "in_progress" as const,
      returnFor: () => returnTo,
      mobile,
      onAdvance: vi.fn(),
    };
    renderInDnd(
      <CardEnvContext.Provider value={env}>
        <Column id="todo" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
      </CardEnvContext.Provider>,
    );
    return env;
  }

  it("puts the return arrow at the bottom left and the advance arrow at the bottom right on a phone", () => {
    renderTodo(true);
    const back = screen.getByRole("button", { name: "Return PROT-02 to Backlog" });
    const next = screen.getByRole("button", { name: "Move PROT-02 to In Progress" });
    expect(back.parentElement).toBe(next.parentElement);
    expect(back.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(back.parentElement).not.toHaveClass("min-h-[18px]");
  });

  it("shows only the arrows that apply", () => {
    renderTodo(true, null);
    expect(screen.queryByRole("button", { name: /^Return/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Move/ })).toBeInTheDocument();
  });

  it("keeps the advance arrow in the head on a wide screen, with no return arrow", () => {
    renderTodo(false);
    expect(screen.queryByRole("button", { name: /^Return/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Move/ }).parentElement).toHaveClass("min-h-[18px]");
  });
});

describe("a card's scout badge", () => {
  function renderRunning(partial: Partial<BoardCard>) {
    const card = makeCard({ status: "running", stage: 3, ...partial });
    const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn() };
    return renderInDnd(
      <CardEnvContext.Provider value={env}>
        <Column id="in_progress" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
      </CardEnvContext.Provider>,
    );
  }

  it("shows the count beside an ant, not the words 'scouts out'", () => {
    renderRunning({ scouts: 1, scoutPick: null });
    const tags = screen.getByTestId("card-tags");
    expect(tags.querySelector("[data-scouts]")?.textContent).toBe("1");
    expect(tags.querySelector("canvas[data-testid='scout-ant']")).not.toBeNull();
    expect(screen.getByLabelText("1 scout out")).toBeTruthy();
    expect(tags.textContent).not.toContain("scouts out");
  });

  it("shows no ant without scouts", () => {
    renderRunning({ scouts: 0 });
    expect(screen.queryByTestId("scout-ant")).toBeNull();
  });
});

describe("a card's entry time", () => {
  const enteredAt = "2026-03-05T14:30:00Z";
  const renderIn = (id: "todo" | "done", card: BoardCard) =>
    renderInDnd(<Column id={id} cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />);
  const short = new Date(enteredAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  it("shows the date and time, labelled as done, in Done", () => {
    renderIn("done", makeCard({ status: "merged", enteredAt }));
    expect(screen.getByText(`Done ${short}`)).toBeTruthy();
  });

  it("holds the full timestamp in the title", () => {
    renderIn("todo", makeCard({ status: "ready", enteredAt }));
    const el = screen.getByText(short);
    expect(el.getAttribute("title")).toBe(new Date(enteredAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" }));
  });

  it("shows nothing before it has entered", () => {
    const { container } = renderIn("todo", makeCard({ status: "ready", enteredAt: null }));
    expect(container.querySelector("time")).toBeNull();
  });
});
