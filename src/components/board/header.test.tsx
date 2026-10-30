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

const renderHeader = () =>
  render(<BoardHeader projectName="Formic" repoFullName="acme/formic" />);

describe("BoardHeader calls link", () => {
  it("links to the Calls page from both headers", () => {
    renderHeader();
    const links = screen.getAllByRole("link", { name: "Calls" });
    expect(links).toHaveLength(2);
    links.forEach((l) => expect(l).toHaveAttribute("href", "/calls"));
  });
});

describe("BoardHeader project button", () => {
  it("shows the Formic logo and no count when no other project has news", () => {
    renderHeader();
    expect(screen.getAllByTestId("formic-logo")).toHaveLength(2);
    expect(screen.queryByTestId("notification-icon")).toBeNull();
    expect(screen.queryByText("acme / formic")).toBeNull();
  });

  it("keeps the Formic logo and adds the count badge", () => {
    activity.count = 2;
    renderHeader();
    expect(screen.getAllByTestId("formic-logo")).toHaveLength(2);
    expect(screen.queryByTestId("notification-icon")).toBeNull();
    const button = screen.getAllByRole("button", {
      name: /2 other projects have something new/,
    })[0]!;
    expect(button).toHaveTextContent("2");
  });

  it("opens the picker on click and closes it on a second click", async () => {
    setViewportMatches(false);
    renderHeader();
    const button = screen.getAllByRole("button", {
      name: /Choose another project/,
    })[0]!;
    await userEvent.click(button);
    expect(screen.getAllByTestId("repo-picker")).toHaveLength(1);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(button);
    expect(screen.queryByTestId("repo-picker")).toBeNull();
  });

  it("mounts a single picker from the mobile app bar", async () => {
    setViewportMatches(true);
    renderHeader();
    const buttons = screen.getAllByRole("button", {
      name: /Choose another project/,
    });
    await userEvent.click(buttons[1]!);
    expect(screen.getAllByTestId("repo-picker")).toHaveLength(1);
  });

  it("puts the mobile ask button after the logo and before the account menu", () => {
    setViewportMatches(true);
    render(
      <BoardHeader
        projectName="Formic"
        repoFullName="acme/formic"
        account={{ login: "ada", name: "Ada" } as never}
        assistant={
          {
            open: false,
            setOpen: vi.fn(),
            messages: [],
            presets: [],
          } as never
        }
      />,
    );
    const logo = screen.getAllByRole("button", {
      name: /Choose another project/,
    })[1]!;
    const ask = screen.getByRole("button", { name: "Ask the PM" });
    const account = screen.getAllByLabelText(/^Account:/)[1]!;
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(logo, ask)).toBe(true);
    expect(follows(ask, account)).toBe(true);
  });
});
