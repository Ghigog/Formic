import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsForm } from "./settings-form";

const account = { login: "octo", name: "Octo Cat", avatarUrl: null, signedIn: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
