import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CoinBadge } from "./coin-badge";

/**
 * The badge is two nested clipped elements, and the reason is easy to undo by
 * accident: `clip-path` cuts a CSS border off at the diagonals, so the 1px
 * edge has to be a separate filled element behind the fill. A refactor that
 * "simplifies" it to `border: 1px` renders a badge with three sides.
 */
describe("CoinBadge", () => {
  it("draws the edge as an outer element, not a border", () => {
    render(<CoinBadge title="Ticket size">M</CoinBadge>);

    const outer = screen.getByTitle("Ticket size");
    const inner = outer.firstElementChild;

    expect(outer).toHaveClass("oct");
    expect(inner).not.toBeNull();
    expect(inner).toHaveClass("oct");
    expect(inner).toHaveTextContent("M");
  });

  it("tints the epic and merged tones differently", () => {
    const { rerender } = render(<CoinBadge tone="epic">EPIC</CoinBadge>);
    expect(screen.getByText("EPIC").className).toContain("bg-epic-chip");

    rerender(<CoinBadge tone="merged">EPIC</CoinBadge>);
    expect(screen.getByText("EPIC").className).toContain("bg-jade-chip");
  });

  it("changes a neutral badge's fill to sit on a cream ground", () => {
    const { rerender } = render(<CoinBadge>02</CoinBadge>);
    expect(screen.getByText("02").className).toContain("bg-card");

    rerender(<CoinBadge ground="cream">02</CoinBadge>);
    expect(screen.getByText("02").className).toContain("bg-cream");
  });
});
