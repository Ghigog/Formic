import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
