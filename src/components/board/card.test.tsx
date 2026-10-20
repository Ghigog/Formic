import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Column } from "./column";
import { EMPTY_VIEW } from "./view";
import { CardEnvContext } from "./card";
import { renderInDnd } from "@/test/render";
import { makeCard } from "@/test/cards";
import type { BoardCard } from "@/lib/domain/entities";

function renderReview(card: BoardCard, repo: { noCi?: boolean; autoMerge?: boolean } = {}) {
  const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn(), ...repo };
  return renderInDnd(
    <CardEnvContext.Provider value={env}>
      <Column id="in_review" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
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

  it("says CI is running while checks are expected", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }));
    expect(screen.getByText("CI running")).toBeTruthy();
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

describe("the queen mark", () => {
  it("shows on a card with a Queen and not on one without", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4, queen: true }));
    expect(screen.getByLabelText("Queen placed")).toBeTruthy();
  });

  it("is absent without a Queen", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }));
    expect(screen.queryByLabelText("Queen placed")).toBeNull();
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
