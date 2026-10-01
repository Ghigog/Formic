import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider } from "./colony";
import { ColonyHeaderStats, ColonyMobileStats } from "./header-stats";
import { SentinelsProvider } from "@/components/sentinels/store";

/** The header's corner with a colony and the sentinels around it. */
function renderHeader(ui: ReactNode = <ColonyHeaderStats />) {
  return render(
    <ColonyProvider
      storageKey="colony-test-header-stats"
      cards={[]}
      extras={{}}
    >
      <SentinelsProvider initial={{}} level={1}>
        {ui}
      </SentinelsProvider>
    </ColonyProvider>,
  );
}

describe("ColonyHeaderStats", () => {
  it("shows the grade badge next to the LV counter, and no sentinels button", async () => {
    renderHeader();

    // The tier rating button stays, beside the level counter.
    const grade = screen.getByRole("button", { name: /Audit grade/ });
    expect(screen.getByText("LV")).toBeInTheDocument();
    expect(grade).toBeInTheDocument();

    // The labelled Sentinels button is gone.
    expect(
      screen.queryByRole("button", { name: "Open sentinels" }),
    ).not.toBeInTheDocument();

    // The grade badge still opens the sentinels.
    await userEvent.click(grade);
    expect(grade).toHaveAttribute("aria-expanded", "true");
  });

  it("has no mute button", () => {
    renderHeader();
    expect(
      screen.queryByRole("button", { name: /mute sounds/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the level text, XP bar and timeline label with pips on desktop", () => {
    renderHeader();
    expect(screen.getByText(/^Colony · /)).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Experience to next level" }),
    ).toHaveAttribute("aria-valuenow", "0");
    expect(
      screen.getByRole("button", { name: "Open timeline" }),
    ).toHaveTextContent("Timeline");
  });

  it("omits the LV badge and XP bar with showLevel false, keeping points, heat and timeline", () => {
    renderHeader(<ColonyHeaderStats showLevel={false} />);
    expect(screen.queryByText("LV")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(document.querySelector('[data-colony="score"]')).toBeInTheDocument();
    expect(document.querySelector('[data-colony="heat"]')).toBeInTheDocument();
    expect(
      document.querySelector('[data-colony="timeline"]'),
    ).toBeInTheDocument();
  });
});

describe("ColonyMobileStats", () => {
  it("shows heat and an icon-only timeline button that toggles the timeline", async () => {
    renderHeader(<ColonyMobileStats />);
    expect(document.querySelector('[data-colony="heat"]')).toBeInTheDocument();

    const open = screen.getByRole("button", { name: "Open timeline" });
    expect(open).not.toHaveTextContent("Timeline");
    expect(open).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(open);

    const back = screen.getByRole("button", { name: "Back to board" });
    expect(back).toHaveAttribute("aria-expanded", "true");
    expect(back).not.toHaveTextContent("ESC");
    await userEvent.click(back);
    expect(
      screen.getByRole("button", { name: "Open timeline" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});
