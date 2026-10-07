import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsForm } from "./settings-form";

const account = { login: "octo", name: "Octo Cat", avatarUrl: null, signedIn: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sound", () => {
  afterEach(() => window.localStorage.clear());

  it("is on by default and saves the choice when toggled", async () => {
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );
    const sw = screen.getByRole("switch", { name: "Sound" });
    expect(sw).toBeChecked();

    await userEvent.click(sw);

    expect(sw).not.toBeChecked();
    expect(window.localStorage.getItem("formic:sound")).toBe("off");
  });
});

describe("Danger zone", () => {
  it("deletes nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );

    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete my account" }));
    });

    expect(window.confirm).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls DELETE /api/account with confirm: true once confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    // jsdom does not implement navigation; deleting the account sends the
    // browser to /login, which is out of scope for this test.
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });

    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );

    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete my account" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ confirm: true }) }),
    );

    Object.defineProperty(window, "location", { value: originalLocation, writable: true });
  });

  it("is not shown in local mode, where there is no account to delete", () => {
    render(
      <SettingsForm
        account={{ ...account, signedIn: false }}
        installUrl={null}
        e2b={{ hint: null, serverFallback: false }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Delete my account" })).not.toBeInTheDocument();
  });
});

describe("Sandbox key", () => {
  const form = (e2b: Parameters<typeof SettingsForm>[0]["e2b"]) =>
    render(<SettingsForm account={account} installUrl={null} e2b={e2b} />);

  it("says how many minutes are left on the server's key", () => {
    form({ hint: null, serverFallback: true, fallbackMinutesLeft: 12 });
    expect(screen.getByText(/12 sandbox minutes left this month/)).toBeInTheDocument();
  });

  it("asks for their own key once the minutes are used", () => {
    form({ hint: null, serverFallback: true, fallbackMinutesLeft: 0 });
    expect(screen.getByText(/Add your own key to keep running/)).toBeInTheDocument();
  });
});

describe("Auto-merge", () => {
  const project = { id: "p1", name: "Formic", autoMerge: false };

  it("shows only the current board, and the label follows the switch", async () => {
    const fetchMock = vi.fn(async () => Response.json({ autoMerge: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SettingsForm
        account={account}
        installUrl={null}
        project={project}
        e2b={{ hint: null, serverFallback: false }}
      />,
    );

    const toggle = screen.getByRole("checkbox", { name: "Merge when move to done" });
    expect(toggle).not.toBeChecked();
    const user = userEvent.setup();
    await act(async () => {
      await user.click(toggle);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ projectId: "p1", autoMerge: true }),
      }),
    );
    expect(toggle).toBeChecked();
    // The label now describes the behaviour it was switched into.
    expect(toggle).toHaveAccessibleName("Auto-merge when review is finished");
  });

  it("stays off and says so when the save is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "no" }, { status: 403 })));
    render(
      <SettingsForm
        account={account}
        installUrl={null}
        project={project}
        e2b={{ hint: null, serverFallback: false }}
      />,
    );
    const toggle = screen.getByRole("checkbox", { name: "Merge when move to done" });
    const user = userEvent.setup();
    await act(async () => {
      await user.click(toggle);
    });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("That did not save. Try again.")).toBeInTheDocument();
  });

  it("shows nothing when there is no board to set it on", () => {
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );
    expect(screen.queryByRole("checkbox", { name: /merge/i })).not.toBeInTheDocument();
  });
});

describe("GitHub access (local mode)", () => {
  it("saves the token through /api/settings", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ e2bKeyHint: null, githubTokenHint: "1234" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SettingsForm
        account={account}
        installUrl={null}
        // A saved sandbox key keeps that field out of its editing state, so the
        // only Save button on the page is this one.
        e2b={{ hint: "abcd", serverFallback: false }}
        github={{ hint: null }}
      />,
    );

    const user = userEvent.setup();
    await act(async () => {
      await user.type(screen.getByLabelText("GitHub access API key"), "ghp_TESTTOKEN1234");
    });
    // The budget and renewal sections have Save buttons of their own.
    const section = screen.getByText("GitHub access").closest("section")!;
    await act(async () => {
      await user.click(within(section).getByRole("button", { name: "Save" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ githubToken: "ghp_TESTTOKEN1234" }),
      }),
    );
  });

  it("is not offered outside local mode, where the sign-in is the credential", () => {
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );

    expect(screen.queryByText("GitHub access")).not.toBeInTheDocument();
  });
});
