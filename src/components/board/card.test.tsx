import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Column } from "./column";
import { EMPTY_VIEW } from "./view";
import { CardEnvContext } from "./card";
import { renderInDnd } from "@/test/render";
import { makeCard } from "@/test/cards";
import type { BoardCard } from "@/lib/domain/entities";

function renderReview(card: BoardCard) {
  const env = { epics: new Map(), nextFor: () => null, onAdvance: vi.fn() };
  return renderInDnd(
    <CardEnvContext.Provider value={env}>
      <Column id="in_review" cards={[card]} extras={{}} view={EMPTY_VIEW} onViewChange={vi.fn()} onOpen={vi.fn()} />
    </CardEnvContext.Provider>,
  );
}

describe("a card in review", () => {
  it("shows a yellow Merging dot once it waits in the Merging stage", () => {
    renderReview(makeCard({ status: "review", stage: 7, prNumber: 4 }));
    const chip = screen.getByText("Merging");
    expect(chip.querySelector("span")?.className).toContain("bg-clay");
  });

  it("shows no Merging dot before the Merging stage", () => {
    renderReview(makeCard({ status: "review", stage: 6, prNumber: 4 }));
    expect(screen.queryByText("Merging")).toBeNull();
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
