import { beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    HTMLElement.prototype.animate = (() => ({
      cancel() {},
      finish() {},
    })) as unknown as HTMLElement["animate"];
  });

  it("starts completed epics collapsed and lets the person expand them", async () => {
    const done = makeEpicWithChildren({ key: "DONE-EPIC", status: "merged" }, [
      {
        key: "DONE-1",
        status: "merged",
        storyPoints: 2,
        updatedAt: new Date().toISOString(),
      },
    ]);
    const active = makeEpicWithChildren({ key: "LIVE-EPIC" }, [
      {
        key: "LIVE-1",
        status: "running",
        storyPoints: 2,
        startedAt: new Date().toISOString(),
      },
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

  describe("browsing earlier windows", () => {
    const setup = async (createdAt = new Date(Date.now() - 100 * 86_400_000).toISOString()) => {
      const cards = makeEpicWithChildren({ key: "E" }, [
        {
          key: "T-1",
          status: "running",
          storyPoints: 2,
          createdAt,
          startedAt: new Date().toISOString(),
        },
      ]);
      render(
        <ColonyProvider storageKey="colony-test-timeline-browse" cards={cards} extras={{}}>
          <Open />
          <ColonyTimeline repoName="repo" />
        </ColonyProvider>,
      );
      await userEvent.click(screen.getByText("open timeline"));
    };
    const range = () => screen.getByText(/ – .* · \d+ epic/).textContent;

    it("disables Later and hides Back to today on the live window", async () => {
      await setup();
      expect(screen.getByRole("button", { name: "Later" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Back to today" })).not.toBeInTheDocument();
      expect(screen.getByText("NOW")).toBeInTheDocument();
    });

    it("steps back, drops the live markers, and returns", async () => {
      await setup();
      const live = range();
      await userEvent.click(screen.getByRole("button", { name: "Earlier" }));
      expect(range()).not.toBe(live);
      expect(screen.queryByText("NOW")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Later" })).toBeEnabled();

      await userEvent.click(screen.getByRole("button", { name: "Later" }));
      expect(range()).toBe(live);
      expect(screen.getByText("NOW")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Earlier" }));
      await userEvent.click(screen.getByRole("button", { name: "Earlier" }));
      await userEvent.click(screen.getByRole("button", { name: "Back to today" }));
      expect(range()).toBe(live);
      expect(screen.getByRole("button", { name: "Later" })).toBeDisabled();
    });

    it("disables Earlier once the window starts before the oldest card", async () => {
      await setup(new Date().toISOString());
      // The live window already starts before a card made just now.
      expect(screen.getByRole("button", { name: "Earlier" })).toBeDisabled();

      cleanup();
      await setup(new Date(Date.now() - 30 * 86_400_000).toISOString());
      await userEvent.click(screen.getByRole("button", { name: "Earlier" }));
      expect(screen.getByRole("button", { name: "Earlier" })).toBeDisabled();
    });
  });
});
