import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupDialog } from "./setup-dialog";

const waiting = { state: "waiting", setupUrl: "https://github.com/acme/widgets/pull/7", update: false } as const;

describe("the setup dialog", () => {
  it("asks for the setup pull request, and mentions the first ticket", () => {
    render(<SetupDialog setup={waiting} repoName="widgets" keyless={[]} onRetry={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Getting widgets ready" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open pull request/ }).getAttribute("href")).toBe(waiting.setupUrl);
    expect(screen.getByText(/AGENTS\.md/)).toBeTruthy();
  });

  it("says it is an update when the workflow changed", () => {
    render(<SetupDialog setup={{ ...waiting, update: true }} repoName="widgets" keyless={[]} onRetry={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Formic's agent workflow changed" })).toBeTruthy();
    expect(screen.queryByText(/AGENTS\.md/)).toBeNull();
  });

  it("lists agents that still need a key", async () => {
    const onAdd = vi.fn();
    render(
      <SetupDialog
        setup={waiting}
        repoName="widgets"
        keyless={[{ name: "Claude Code", keyName: "Claude Code token", onAdd }]}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText("Add a Claude Code token to Claude Code")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("folds into a reminder on Not now, and opens again from it", async () => {
    render(<SetupDialog setup={waiting} repoName="widgets" keyless={[]} onRetry={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Setup pull request waiting/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows why it cannot set up, with a retry", async () => {
    const onRetry = vi.fn();
    render(
      <SetupDialog
        setup={{ state: "blocked", reason: "Formic's GitHub App needs Workflows access." }}
        repoName="widgets"
        keyless={[]}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText(/needs Workflows access/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows nothing once the repository is ready", () => {
    const { container } = render(
      <SetupDialog setup={{ state: "ready" }} repoName="widgets" keyless={[]} onRetry={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
