import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunnerSection } from "./runner-section";
import type { MachinesResponse } from "@/app/api/runner/machines/route";

afterEach(() => vi.unstubAllGlobals());

function answer(m: MachinesResponse) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(m)));
  render(<RunnerSection />);
}

describe("the Runner settings", () => {
  it("warns that a private repository's minutes are billed, and says how to run free", async () => {
    answer({ repoFullName: "acme/game", private: true, runners: [] });
    expect(await screen.findByText(/game is private/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "New self-hosted runner ↗" })).toHaveAttribute(
      "href",
      "https://github.com/acme/game/settings/actions/runners/new",
    );
    expect(screen.getByText("FORMIC_RUNNER")).toBeTruthy();
    expect(screen.getByText("No runner added yet.")).toBeTruthy();
  });

  it("says a public repository runs free", async () => {
    answer({ repoFullName: "acme/game", private: false, runners: [] });
    expect(await screen.findByText("game is public, so its Actions minutes are free.")).toBeTruthy();
  });

  it("shows the repository's own runners and whether they are on", async () => {
    answer({
      repoFullName: "acme/game",
      private: true,
      runners: [
        { name: "desk", online: true, busy: false, labels: ["self-hosted", "Linux"] },
        { name: "laptop", online: false, busy: false, labels: ["self-hosted"] },
      ],
    });
    expect(await screen.findByText("desk")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
  });
});
