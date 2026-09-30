import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ArchiveButton, ArchiveGrid } from ".";

function serve(tickets: unknown[], ok = true) {
  const fetchMock = vi.fn(async () =>
    ok ? Response.json({ tickets }) : new Response("no", { status: 500 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("ArchiveButton", () => {
  it("is labelled Archive and calls onClick", () => {
    const onClick = vi.fn();
    render(<ArchiveButton onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("ArchiveGrid", () => {
  it("renders nothing and does not fetch while closed", () => {
    const fetchMock = serve([]);
    const { container } = render(<ArchiveGrid open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches when opened and shows the archived tickets", async () => {
    const fetchMock = serve([
      { id: "1", key: "T-1", title: "First" },
      { id: "2", key: "T-2", title: "Second" },
    ]);
    render(<ArchiveGrid open onClose={() => {}} />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(await screen.findByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/archived");
  });

  it("shows an empty state", async () => {
    serve([]);
    render(<ArchiveGrid open onClose={() => {}} />);
    expect(await screen.findByText("No archived tickets yet.")).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    serve([], false);
    render(<ArchiveGrid open onClose={() => {}} />);
    expect(await screen.findByText(/Could not load/)).toBeInTheDocument();
  });

  it("calls onClose from the close button", async () => {
    serve([]);
    const onClose = vi.fn();
    render(<ArchiveGrid open onClose={onClose} />);
    await screen.findByText("No archived tickets yet.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
