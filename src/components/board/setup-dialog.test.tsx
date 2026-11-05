import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupCard, SetupDialog } from "./setup-dialog";
import { endTour, startTour } from "@/components/onboarding/store";

const waiting = {
  state: "waiting",
  setupUrl: "https://github.com/acme/widgets/pull/7",
  update: false,
} as const;

describe("the setup dialog", () => {
  it("says a private repository's agent runs are billed, and links to the runner settings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ repoFullName: "acme/widgets", private: true, runners: [] })));
    render(
      <SetupDialog setup={waiting} repoName="widgets" repoFullName="acme/widgets" keyless={[]} onRetry={() => {}} />,
    );
    expect(await screen.findByText(/widgets is private/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "setting up a self-hosted runner" })).toHaveAttribute("href", "/settings#runner");
    vi.unstubAllGlobals();
  });

  it("waits for the guided tour to finish", () => {
    act(() => startTour("board"));
    render(
      <SetupDialog setup={waiting} repoName="widgets" repoFullName="acme/widgets" keyless={[]} onRetry={() => {}} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => endTour());
    expect(screen.getByRole("dialog", { name: "Getting widgets ready" })).toBeTruthy();
  });

  it("asks for the setup pull request, and mentions the first ticket", () => {
    render(
      <SetupDialog
        setup={waiting}
        repoName="widgets"
        repoFullName="acme/widgets"
        keyless={[]}
        onRetry={() => {}}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Getting widgets ready" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Open pull request/ })
        .getAttribute("href"),
    ).toBe(waiting.setupUrl);
    expect(screen.getByText(/AGENTS\.md/)).toBeTruthy();
  });

  it("says it is an update when the workflow changed", () => {
    render(
      <SetupDialog
        setup={{ ...waiting, update: true }}
        repoName="widgets"
        repoFullName="acme/widgets"
        keyless={[]}
        onRetry={() => {}}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Formic's agent workflow changed" }),
    ).toBeTruthy();
    expect(screen.queryByText(/AGENTS\.md/)).toBeNull();
  });

  it("lists the secret each CLI agent needs, linking to the repository's Actions secrets", () => {
    render(
      <SetupDialog
        setup={waiting}
        repoName="widgets"
        repoFullName="acme/widgets"
        keyless={[
          {
            names: ["Claude Code"],
            keyName: "Claude Code token",
            secretName: "FORMIC_CLAUDE_CODE_TOKEN_P1",
          },
        ]}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText("FORMIC_CLAUDE_CODE_TOKEN_P1")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Actions secrets/ })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/settings/secrets/actions");
    expect(screen.queryByRole("button", { name: "Add key" })).toBeNull();
  });

  it("lists agents that share a secret on one row", () => {
    render(
      <SetupDialog
        setup={waiting}
        repoName="widgets"
        repoFullName="acme/widgets"
        keyless={[
          { names: ["architect", "worker"], keyName: "Claude Code token", secretName: "FORMIC_CLAUDE_CODE_TOKEN" },
        ]}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText("Add a secret for architect, worker")).toBeTruthy();
    expect(screen.getAllByText("FORMIC_CLAUDE_CODE_TOKEN")).toHaveLength(1);
  });

  it("folds into a reminder on Not now, and opens again from it", async () => {
    render(
      <SetupDialog
        setup={waiting}
        repoName="widgets"
        repoFullName="acme/widgets"
        keyless={[]}
        onRetry={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: /Setup pull request waiting/ }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("puts the dialog away the same way on Escape as on Not now, and reopens it", async () => {
    const show = () =>
      render(
        <SetupDialog setup={waiting} repoName="widgets" repoFullName="acme/widgets" keyless={[]} onRetry={() => {}} />,
      );
    const pill = () => screen.getByRole("button", { name: /Setup pull request waiting/ });

    const first = show();
    await waitFor(() => expect(screen.getByRole("link", { name: /Open pull request/ })).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(pill()).toHaveFocus();
    const afterEscape = first.container.innerHTML;
    first.unmount();

    const second = show();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(pill()).toHaveFocus();
    expect(second.container.innerHTML).toBe(afterEscape);

    await userEvent.click(pill());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: /Open pull request/ })).toHaveFocus());

    await userEvent.keyboard("{Escape}");
    expect(pill()).toHaveFocus();
  });

  it("shows why it cannot set up, with a retry", async () => {
    const onRetry = vi.fn();
    render(
      <SetupDialog
        setup={{
          state: "blocked",
          reason: "Formic's GitHub App needs Workflows access.",
        }}
        repoName="widgets"
        repoFullName="acme/widgets"
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
      <SetupDialog
        setup={{ state: "ready" }}
        repoName="widgets"
        repoFullName="acme/widgets"
        keyless={[]}
        onRetry={() => {}}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  describe("once the workflow is merged", () => {
    beforeEach(() => localStorage.clear());
    const keyless = [
      { names: ["worker"], keyName: "Claude Code token", secretName: "FORMIC_CLAUDE_CODE_TOKEN" },
    ];
    const show = () =>
      render(
        <SetupDialog
          setup={{ state: "ready" }}
          repoName="widgets"
          repoFullName="acme/widgets"
          keyless={keyless}
          onRetry={() => {}}
        />,
      );

    it("still asks for the secrets, without the pull request step", async () => {
      show();
      expect(await screen.findByRole("dialog", { name: "Add your agents' secrets" })).toBeTruthy();
      expect(screen.getByText("FORMIC_CLAUDE_CODE_TOKEN")).toBeTruthy();
      expect(screen.queryByRole("link", { name: /Open pull request/ })).toBeNull();
    });

    it("stays away once the person says they added them, and asks again for a new secret", async () => {
      const first = show();
      await userEvent.click(await screen.findByRole("button", { name: "I've added them" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      first.unmount();

      const again = show();
      await waitFor(() => expect(again.container.innerHTML).toBe(""));
      again.unmount();

      render(
        <SetupDialog
          setup={{ state: "ready" }}
          repoName="widgets"
          repoFullName="acme/widgets"
          keyless={[{ ...keyless[0]!, secretName: "FORMIC_CLAUDE_CODE_TOKEN_WORK" }]}
          onRetry={() => {}}
        />,
      );
      expect(await screen.findByRole("dialog")).toBeTruthy();
    });

    it("folds into a reminder on Not now", async () => {
      show();
      await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
      expect(screen.getByRole("button", { name: /Agent secrets not added/ })).toBeTruthy();
    });
  });

  it("wraps Tab and Shift+Tab inside the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ repoFullName: "acme/widgets", private: false, runners: [] })));
    const user = userEvent.setup();
    render(
      <SetupDialog setup={waiting} repoName="widgets" repoFullName="acme/widgets" keyless={[]} onRetry={() => {}} />,
    );
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: /Open pull request/ })));
    const tabbable = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href]")).filter(
      (el) => !(el as HTMLButtonElement).disabled,
    );
    const first = tabbable[0]!;
    const last = tabbable[tabbable.length - 1]!;
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });
});

describe("the setup card", () => {
  it("links the waiting pull request, and goes once the workflow is in", () => {
    const { rerender } = render(<SetupCard setup={waiting} repoName="widgets" onRetry={() => {}} />);
    expect(screen.getByRole("link", { name: /Open pull request/ })).toHaveAttribute("href", waiting.setupUrl);
    rerender(<SetupCard setup={{ state: "ready" }} repoName="widgets" onRetry={() => {}} />);
    expect(screen.queryByTestId("setup-card")).toBeNull();
  });

  it("says why and offers a retry when Formic is blocked", async () => {
    const onRetry = vi.fn();
    render(<SetupCard setup={{ state: "blocked", reason: "Install the app." }} repoName="widgets" onRetry={onRetry} />);
    expect(screen.getByText("Install the app.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });
});
