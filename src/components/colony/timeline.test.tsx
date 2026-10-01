import { beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeEpicWithChildren } from "@/test/cards";
import { ColonyProvider, useColony } from "./colony";
import { ColonyTimeline } from "./timeline";

function Open() {
  const c = useColony();
  return <button onClick={() => c?.setTimelineOpen(true)}>open timeline</button>;
}

describe("ColonyTimeline", () => {
  // jsdom has no Web Animations API.
  beforeAll(() => {
    HTMLElement.prototype.animate = (() => ({ cancel() {}, finish() {} })) as unknown as HTMLElement["animate"];
  });

  it("starts completed epics collapsed and lets the person expand them", async () => {
    const done = makeEpicWithChildren({ key: "DONE-EPIC", status: "merged" }, [
      { key: "DONE-1", status: "merged", storyPoints: 2, updatedAt: new Date().toISOString() },
    ]);
    const active = makeEpicWithChildren({ key: "LIVE-EPIC" }, [
      { key: "LIVE-1", status: "running", storyPoints: 2, startedAt: new Date().toISOString() },
    ]);
    render(
      <ColonyProvider storageKey="colony-test-timeline" cards={[...done, ...active]} extras={{}}>
        <Open />
        <ColonyTimeline repoName="repo" />
      </ColonyProvider>,
    );
    await userEvent.click(screen.getByText("open timeline"));

    const doneToggle = screen.getByRole("button", { name: "Expand DONE-EPIC" });
    expect(doneToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("DONE-1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse LIVE-EPIC" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("LIVE-1")).toBeInTheDocument();

    await userEvent.click(doneToggle);
    expect(screen.getByRole("button", { name: "Collapse DONE-EPIC" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("DONE-1")).toBeInTheDocument();
  });
});
