import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardHeader } from "./header";
import { setViewportMatches } from "@/test/viewport";

const activity = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/hooks/use-assistant-activity", () => ({
  useAssistantActivity: () => ({ count: activity.count, unseen: [] }),
}));
vi.mock("./repo-picker", () => ({
  RepoPicker: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="repo-picker">
      <button onClick={onClose}>Pick</button>
    </div>
  ),
}));
vi.mock("@/components/colony/header-stats", () => ({
  ColonyHeaderStats: () => null,
  ColonyLevelStats: () => null,
  ColonyMobileStats: () => null,
}));

afterEach(() => {
  activity.count = 0;
});

const renderHeader = () => render(<BoardHeader projectName="Formic" repoFullName="acme/formic" />);

describe("BoardHeader project button", () => {
  it("shows the Formic logo and no count when no other project has news", () => {
    renderHeader();
    expect(screen.getAllByTestId("formic-logo")).toHaveLength(2);
    expect(screen.queryByTestId("notification-icon")).toBeNull();
    expect(screen.queryByText("acme / formic")).toBeNull();
  });

  it("swaps to the notification icon with the count", () => {
    activity.count = 2;
    renderHeader();
    expect(screen.queryByTestId("formic-logo")).toBeNull();
    const button = screen.getAllByRole("button", { name: /2 other projects have a new assistant answer/ })[0]!;
    expect(button).toHaveTextContent("2");
  });

  it("opens the picker on click and closes it on a second click", async () => {
    setViewportMatches(false);
    renderHeader();
    const button = screen.getAllByRole("button", { name: /Choose another project/ })[0]!;
    await userEvent.click(button);
    expect(screen.getAllByTestId("repo-picker")).toHaveLength(1);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(button);
    expect(screen.queryByTestId("repo-picker")).toBeNull();
  });

  it("mounts a single picker from the mobile app bar", async () => {
    setViewportMatches(true);
    renderHeader();
    const buttons = screen.getAllByRole("button", { name: /Choose another project/ });
    await userEvent.click(buttons[1]!);
    expect(screen.getAllByTestId("repo-picker")).toHaveLength(1);
  });
});
