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
  ColonyHeaderStats: () => (
    <>
      <span data-testid="level" />
      <span data-testid="points" />
    </>
  ),
  ColonyTimelineButton: ({ iconOnly }: { iconOnly?: boolean }) => (
    <span data-testid={iconOnly ? "timeline-icon" : "timeline"} />
  ),
  ColonyMobileStats: () => null,
}));
vi.mock("./assistant", () => ({
  AskBox: () => <span data-testid="ask-box" />,
  AskButton: () => <button>Ask the PM</button>,
}));

afterEach(() => {
  activity.count = 0;
});

const renderHeader = () =>
  render(<BoardHeader projectName="Formic" repoFullName="acme/formic" />);

describe("BoardHeader calls link", () => {
  it("has no Calls link", () => {
    renderHeader();
    expect(screen.queryByRole("link", { name: "Calls" })).toBeNull();
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

describe("BoardHeader desktop order", () => {
  it("puts the logo and Timeline left, the ask box in the middle, level, points and account right", () => {
    setViewportMatches(false);
    render(
      <BoardHeader
        projectName="Formic"
        repoFullName="acme/formic"
        account={{ login: "ada", name: "Ada" } as never}
        assistant={{} as never}
      />,
    );
    const logo = screen.getAllByRole("button", { name: /Choose another project/ })[0]!;
    const order = [
      logo,
      screen.getByTestId("timeline"),
      screen.getByTestId("ask-box"),
      screen.getByTestId("level"),
      screen.getByTestId("points"),
      screen.getAllByLabelText(/^Account:/)[0]!,
    ];
    order.slice(1).forEach((el, i) =>
      expect(
        Boolean(order[i]!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true),
    );
    const header = logo.closest("header")!;
    const columns = Array.from(header.children);
    expect(columns[0]).toContainElement(screen.getByTestId("timeline"));
    expect(columns[1]).toContainElement(screen.getByTestId("ask-box"));
    expect(columns[2]).toContainElement(screen.getByTestId("level"));
  });

  it("puts the icon-only Timeline after the logo and before the ask button on the phone", () => {
    setViewportMatches(true);
    render(
      <BoardHeader projectName="Formic" repoFullName="acme/formic" assistant={{} as never} />,
    );
    const logo = screen.getAllByRole("button", { name: /Choose another project/ })[1]!;
    const tl = screen.getByTestId("timeline-icon");
    const ask = screen.getByRole("button", { name: "Ask the PM" });
    expect(logo.compareDocumentPosition(tl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tl.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("BoardHeader locked features", () => {
  it("renders no Sentinels or Timeline entry of its own, on desktop or phone", () => {
    for (const phone of [false, true]) {
      setViewportMatches(phone);
      const { unmount } = renderHeader();
      expect(screen.queryByRole("button", { name: /sentinels/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /timeline/i })).toBeNull();
      unmount();
    }
  });
});
