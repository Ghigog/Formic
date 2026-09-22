import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProgressBar } from "./progress-bar";

describe("ProgressBar", () => {
  it("names itself, since it has no visible label", () => {
    render(<ProgressBar value={0.62} label="PROT-06 progress" />);
    expect(screen.getByRole("progressbar")).toHaveAccessibleName("PROT-06 progress");
  });

  it("reports a rounded percentage", () => {
    render(<ProgressBar value={0.625} label="p" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "63");
  });

  it("clamps a value outside 0..1 rather than overflowing the track", () => {
    const { rerender } = render(<ProgressBar value={1.4} label="p" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");

    rerender(<ProgressBar value={-0.2} label="p" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("leaves aria-valuenow unset when the fraction is unknown", () => {
    render(<ProgressBar value={null} label="p" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    // An indeterminate bar is dimmed rather than animated: the motion budget
    // is two loops, and a travelling bar is not one of them.
    expect(bar.firstElementChild!.className).toContain("opacity-50");
  });

  it("renders the caption that carries the meaning", () => {
    render(
      <ProgressBar value={0.62} label="p" caption="Running vitest · 13/21 files" />,
    );
    expect(screen.getByText("Running vitest · 13/21 files")).toBeInTheDocument();
  });
});
