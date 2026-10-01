import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider } from "./colony";
import { ColonyHeaderStats } from "./header-stats";
import { SentinelsProvider } from "@/components/sentinels/store";

/** The header's corner with a colony and the sentinels around it. */
function renderHeader() {
  return render(
    <ColonyProvider storageKey="colony-test-header-stats" cards={[]} extras={{}}>
      <SentinelsProvider initial={{}} level={1}>
        <ColonyHeaderStats />
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
    expect(screen.queryByRole("button", { name: "Open sentinels" })).not.toBeInTheDocument();

    // The grade badge still opens the sentinels.
    await userEvent.click(grade);
    expect(grade).toHaveAttribute("aria-expanded", "true");
  });

  it("has no mute button", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: /mute sounds/i })).not.toBeInTheDocument();
  });
});
