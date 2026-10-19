import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DesktopAppSection } from "./desktop-app-section";

function onPlatform(platform: string, maxTouchPoints = 0) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  // jsdom has no maxTouchPoints, so it is defined rather than spied on.
  Object.defineProperty(navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
});

describe("DesktopAppSection", () => {
  it("shows the build steps and the full guide on a Mac", () => {
    onPlatform("MacIntel");
    render(<DesktopAppSection />);

    expect(screen.getByText(/bash deploy\/mac\/build\.sh/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Full guide" })).toHaveAttribute(
      "href",
      expect.stringContaining("deploy/mac/README.md"),
    );
  });

  it("says the app is Mac only everywhere else", () => {
    onPlatform("Win32");
    render(<DesktopAppSection />);

    expect(screen.getByText(/Mac only for now/)).toBeInTheDocument();
    expect(screen.queryByText(/build\.sh/)).not.toBeInTheDocument();
  });

  it("treats an iPad asking for the desktop site as not a Mac", () => {
    onPlatform("MacIntel", 5);
    render(<DesktopAppSection />);

    expect(screen.getByText(/Mac only for now/)).toBeInTheDocument();
  });
});
