import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SentinelsProvider } from "./store";
import { SENTINELS } from "@/lib/sentinels/roster";
import { UnlockAllDialog, shouldOfferUnlockAll } from "./unlock-all-dialog";

const TOP = Math.max(...SENTINELS.map((s) => s.unlockLevel));

function answer(body: object) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function at(level: number, ui: ReactNode) {
  return render(
    <SentinelsProvider initial={{}} level={level}>
      {ui}
    </SentinelsProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("shouldOfferUnlockAll", () => {
  const base = { established: true, level: 0, unlockAll: false, dismissedAt: null };

  it("offers when established with Sentinels still locked and nothing settled", () => {
    expect(shouldOfferUnlockAll(base)).toBe(true);
  });
  it.each([
    ["a short history", { established: false }],
    ["unlockAll on", { unlockAll: true }],
    ["a dismissal on the server", { dismissedAt: "2026-11-01T00:00:00.000Z" }],
    ["every Sentinel unlocked by level", { level: TOP }],
  ])("does not offer with %s", (_name, over) => {
    expect(shouldOfferUnlockAll({ ...base, ...over })).toBe(false);
  });
});

describe("UnlockAllDialog", () => {
  it("offers the Settings toggle when established and Sentinels are locked", async () => {
    answer({ established: true, unlockAllSentinels: false, unlockAllOfferDismissedAt: null });
    at(0, <UnlockAllDialog projectId="p1" unlockAll={false} />);

    expect(await screen.findByRole("dialog")).toHaveTextContent("All Sentinels can be unlocked in Settings");
    expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings#sentinels");
  });

  it("does not appear for a short history", async () => {
    const fetchMock = answer({ established: false, unlockAllSentinels: false, unlockAllOfferDismissedAt: null });
    at(0, <UnlockAllDialog projectId="p1" unlockAll={false} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not appear when the server holds a dismissal, whatever this device remembers", async () => {
    const fetchMock = answer({ established: true, unlockAllSentinels: false, unlockAllOfferDismissedAt: "2026-11-01T00:00:00.000Z" });
    at(0, <UnlockAllDialog projectId="p1" unlockAll={false} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not appear when the colony level has unlocked every Sentinel", async () => {
    const fetchMock = answer({ established: true, unlockAllSentinels: false, unlockAllOfferDismissedAt: null });
    at(TOP, <UnlockAllDialog projectId="p1" unlockAll={false} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not appear, or ask, when the setting is already on", () => {
    const fetchMock = answer({ established: true });
    at(0, <UnlockAllDialog projectId="p1" unlockAll />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("records Not now on the project, and never switches the setting itself", async () => {
    const fetchMock = answer({ established: true, unlockAllSentinels: false, unlockAllOfferDismissedAt: null });
    at(0, <UnlockAllDialog projectId="p1" unlockAll={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe("/api/projects/p1");
    expect(JSON.parse(writes[0]![1].body)).toEqual({ unlockAllOfferDismissed: true });
  });

  it("records Open Settings on the project too", async () => {
    const fetchMock = answer({ established: true, unlockAllSentinels: false, unlockAllOfferDismissedAt: null });
    at(0, <UnlockAllDialog projectId="p1" unlockAll={false} />);
    await userEvent.click(await screen.findByRole("link", { name: "Open Settings" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
  });
});
