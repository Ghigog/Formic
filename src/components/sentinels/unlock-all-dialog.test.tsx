import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnlockAllDialog } from "./unlock-all-dialog";

function answer(body: object) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("UnlockAllDialog", () => {
  it("offers the Settings toggle when the project is established and the setting is off", async () => {
    answer({ established: true, unlockAllSentinels: false });
    render(<UnlockAllDialog projectId="p1" unlockAll={false} />);

    expect(await screen.findByRole("dialog")).toHaveTextContent("All Sentinels can be unlocked in Settings");
    expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings#sentinels");
  });

  it("does not appear for a short history", async () => {
    const fetchMock = answer({ established: false, unlockAllSentinels: false });
    render(<UnlockAllDialog projectId="p1" unlockAll={false} />);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not appear, or ask, when the setting is already on", () => {
    const fetchMock = answer({ established: true });
    render(<UnlockAllDialog projectId="p1" unlockAll />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays away once dismissed, and never switches the setting itself", async () => {
    const fetchMock = answer({ established: true, unlockAllSentinels: false });
    const { unmount } = render(<UnlockAllDialog projectId="p1" unlockAll={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();

    fetchMock.mockClear();
    render(<UnlockAllDialog projectId="p1" unlockAll={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, init]) => !init || init.method === undefined)).toBe(true);
  });

  it("is remembered when the owner takes its action", async () => {
    answer({ established: true, unlockAllSentinels: false });
    render(<UnlockAllDialog projectId="p1" unlockAll={false} />);
    await userEvent.click(await screen.findByRole("link", { name: "Open Settings" }));
    expect(localStorage.getItem("formic:unlock-all-sentinels:p1")).not.toBeNull();
  });
});
