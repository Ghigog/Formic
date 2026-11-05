import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchiveView } from "./archive-view";
import { makeCard } from "@/test/cards";
import type { BoardCard } from "@/lib/domain/entities";

const fetchMock = vi.fn();

function serve(tickets: BoardCard[], restoreOk = true, epics: BoardCard[] = []) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return { ok: restoreOk, json: async () => ({}) };
    return { ok: true, json: async () => ({ tickets, epics }) };
  });
}

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const open = (onClose = vi.fn(), onRestored = vi.fn()) => {
  render(<ArchiveView onClose={onClose} onRestored={onRestored} />);
  return { onClose, onRestored };
};

describe("ArchiveView", () => {
  it("lists every archived card", async () => {
    serve([makeCard({ title: "One", archived: true }), makeCard({ title: "Two", archived: true })]);
    open();
    expect(await screen.findByText("One")).toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
  });

  it("lists an archived Epic and restores it through the Epic route", async () => {
    const epic = makeCard({
      kind: "epic",
      key: "EPIC-9",
      title: "Old Epic",
      archived: true,
    });
    serve([makeCard({ title: "A ticket", archived: true })], true, [epic]);
    const { onRestored } = open();
    await userEvent.click(await screen.findByRole("button", { name: /Restore EPIC-9/ }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/epics/${epic.id}/archive`, {
      method: "DELETE",
    });
    await waitFor(() => expect(screen.queryByText("Old Epic")).toBeNull());
    expect(screen.getByText("A ticket")).toBeInTheDocument();
    expect(onRestored).toHaveBeenCalledWith({ ...epic, archived: false });
  });

  it("shows an empty message with no archived cards", async () => {
    serve([]);
    open();
    expect(await screen.findByText("No archived cards.")).toBeInTheDocument();
  });

  it("restores a clicked card and removes it from the grid", async () => {
    const card = makeCard({ title: "Old", status: "running", archived: true });
    serve([card]);
    const { onRestored } = open();
    await userEvent.click(await screen.findByRole("button", { name: /Restore/ }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/tickets/${card.id}/archive`, {
      method: "DELETE",
    });
    await waitFor(() => expect(screen.queryByText("Old")).toBeNull());
    expect(onRestored).toHaveBeenCalledWith({ ...card, archived: false });
  });

  it("keeps the card and shows an error when the restore fails", async () => {
    serve([makeCard({ title: "Stuck", archived: true })], false);
    const { onRestored } = open();
    await userEvent.click(await screen.findByRole("button", { name: /Restore/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Stuck")).toBeInTheDocument();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("closes on Escape and on a backdrop click", async () => {
    serve([]);
    const { onClose } = open();
    await screen.findByText("No archived cards.");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("archive-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  describe("Show older", () => {
    const first = [makeCard({ title: "Newest", archived: true })];
    const second = [makeCard({ title: "Older", archived: true })];
    const pages = (second_: () => Promise<unknown>) =>
      fetchMock.mockImplementation(async (url: string) =>
        url.includes("cursor=c2")
          ? second_()
          : {
              ok: true,
              json: async () => ({
                tickets: first,
                epics: [],
                nextCursor: "c2",
              }),
            },
      );

    it("appends the next page and drops the link on the last page", async () => {
      pages(async () => ({
        ok: true,
        json: async () => ({
          tickets: [...first, ...second],
          epics: [],
          nextCursor: null,
        }),
      }));
      open();
      await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
      expect(await screen.findByText("Older")).toBeInTheDocument();
      expect(screen.getAllByText("Newest")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
    });

    it("reads Loading… and cannot be tapped twice while the page loads", async () => {
      let release!: (v: unknown) => void;
      pages(() => new Promise((r) => (release = r)));
      open();
      await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
      release({
        ok: true,
        json: async () => ({ tickets: second, epics: [], nextCursor: null }),
      });
      expect(await screen.findByText("Older")).toBeInTheDocument();
    });

    it("keeps the cards and offers a retry when the page fails", async () => {
      pages(async () => ({ ok: false, json: async () => ({}) }));
      open();
      await userEvent.click(await screen.findByRole("button", { name: "Show older" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/older cards/i);
      expect(screen.getByText("Newest")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show older" })).toBeInTheDocument();
    });
  });

  it("wraps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    serve([makeCard({ title: "One", archived: true })]);
    open();
    await screen.findByRole("button", { name: /Restore/ });
    const dialog = screen.getByRole("dialog");
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
