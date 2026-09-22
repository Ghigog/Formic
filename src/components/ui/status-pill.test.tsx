import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusChip, StatusPill } from "./status-pill";
import { TICKET_STATUSES } from "@/lib/domain/status";
import { STATUS_LABEL } from "@/lib/tokens";

/**
 * The design rule this guards: the status colour lives in the dot, never in
 * the label. Tinting the label would force a darker variant of every status
 * colour to clear 4.5:1, and the palette drifts one state at a time.
 */
describe("StatusPill", () => {
  it.each(TICKET_STATUSES)("keeps %s's colour out of the label", (status) => {
    const { container } = render(<StatusPill status={status} />);

    const chip = container.firstElementChild!;
    const dot = chip.firstElementChild!;

    // The label is anthracite on every status.
    expect(chip.className).toContain("text-ink");
    // The colour is on the dot, and the dot alone.
    expect(dot.className).toMatch(/\bbg-(idle|clay|jade|rust|crimson|terracotta)\b/);
    expect(chip).toHaveTextContent(STATUS_LABEL[status]);
  });

  it("breathes only while an agent is live", () => {
    const { container, rerender } = render(<StatusPill status="running" />);
    expect(container.querySelector(".pulse-dot")).not.toBeNull();

    for (const status of TICKET_STATUSES.filter((s) => s !== "running")) {
      rerender(<StatusPill status={status} />);
      expect(container.querySelector(".pulse-dot")).toBeNull();
    }
  });

  it("appends an optional detail without colouring it", () => {
    render(<StatusPill status="failed" detail="scope violation" />);
    expect(screen.getByText(/scope violation/)).toHaveClass("text-muted");
  });
});

describe("StatusChip", () => {
  it("tints its ground at 12% of the tone", () => {
    const { container } = render(<StatusChip tone="crimson">2 checks failed</StatusChip>);
    expect(container.firstElementChild!.className).toContain("bg-crimson/12");
  });

  it("pulses only when told to", () => {
    const { container, rerender } = render(<StatusChip tone="clay">Coder Agent</StatusChip>);
    expect(container.querySelector(".pulse-dot")).toBeNull();

    rerender(
      <StatusChip tone="clay" pulsing>
        Coder Agent
      </StatusChip>,
    );
    expect(container.querySelector(".pulse-dot")).not.toBeNull();
  });
});
