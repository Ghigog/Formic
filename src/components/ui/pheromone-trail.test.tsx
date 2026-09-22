import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ColumnTrail } from "./pheromone-trail";

/**
 * The trail's geometry is arithmetic, not layout: rows are a fixed 60px with
 * an 8px gap precisely so the curve endpoints land on a row's vertical centre
 * without measuring anything. That makes it the one piece of the design that
 * a unit test can pin exactly — and worth pinning, because a change to the
 * row height silently leaves the curves pointing at nothing.
 */
const ROW = 60;
const GAP = 8;
const STEP = ROW + GAP;

function trail(unlocked: boolean[]) {
  const { container } = render(<ColumnTrail unlocked={unlocked} />);
  const svg = container.querySelector("svg");
  const paths = [...container.querySelectorAll("path")];
  return { svg, spine: paths[0], branches: paths.slice(1) };
}

describe("ColumnTrail", () => {
  it("renders nothing for an epic with no children here", () => {
    const { container } = render(<ColumnTrail unlocked={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("sizes itself to the rows it spans", () => {
    const { svg } = trail([false, false, false, false]);
    expect(svg).toHaveAttribute("height", String(4 * ROW + 3 * GAP));
    expect(svg).toHaveAttribute("width", "22");
  });

  it("lands each branch on its row's centre", () => {
    const { branches } = trail([false, false, false]);

    expect(branches).toHaveLength(3);
    branches.forEach((branch, i) => {
      const centre = STEP * i + ROW / 2;
      expect(branch).toHaveAttribute(
        "d",
        `M6 ${STEP * i + 14} Q6 ${centre} 22 ${centre}`,
      );
    });
  });

  it("draws the spine faintly and only as far as the last branch", () => {
    const { spine } = trail([false, false]);
    expect(spine).toHaveAttribute("d", `M6 0 V${STEP + ROW / 2 + 6}`);
    expect(spine).toHaveAttribute("stroke-opacity", "0.22");
  });

  it("turns a branch jade once its dependency has unlocked", () => {
    const { branches } = trail([false, true]);

    expect(branches[0]).toHaveAttribute("stroke", "var(--clay)");
    expect(branches[0]).not.toHaveClass("pulse-trail");

    expect(branches[1]).toHaveAttribute("stroke", "var(--jade)");
    expect(branches[1]).toHaveClass("pulse-trail");
  });
});
