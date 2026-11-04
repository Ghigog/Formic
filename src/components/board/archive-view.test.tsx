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
    const epic = makeCard({ kind: "epic", key: "EPIC-9", title: "Old Epic", archived: true });
    serve([makeCard({ title: "A ticket", archived: true })], true, [epic]);
    const { onRestored } = open();
    await userEvent.click(await screen.findByRole("button", { name: /Restore EPIC-9/ }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/epics/${epic.id}/archive`, { method: "DELETE" });
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
    expect(fetchMock).toHaveBeenCalledWith(`/api/tickets/${card.id}/archive`, { method: "DELETE" });
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
});
