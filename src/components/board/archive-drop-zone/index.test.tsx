import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { ArchiveDropZone } from ".";
import { renderInDnd } from "@/test/render";

afterEach(() => vi.unstubAllGlobals());

describe("ArchiveDropZone", () => {
  it("is labelled Archive", () => {
    renderInDnd(<ArchiveDropZone onArchived={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Archive" })).toBeInTheDocument();
  });

  it("archives the dropped ticket and reports it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const onArchived = vi.fn();
    renderInDnd(<ArchiveDropZone dropped={{ ticketId: "t1" }} onArchived={onArchived} />);
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith("t1"));
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/t1/archive", { method: "PATCH" });
  });

  it("shows an error and keeps the ticket when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const onArchived = vi.fn();
    renderInDnd(<ArchiveDropZone dropped={{ ticketId: "t1" }} onArchived={onArchived} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Archive failed");
    expect(onArchived).not.toHaveBeenCalled();
  });
});
