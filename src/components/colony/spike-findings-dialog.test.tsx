import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SpikeFindingsDialog } from "./spike-findings-dialog";

const colony = vi.hoisted(() => ({ sfx: undefined as unknown, reduced: true }));
vi.mock("./colony", () => ({
  useColony: () => ({ sfx: colony.sfx, fx: { reducedMotion: colony.reduced } }),
}));

const ticket = { id: "t1", key: "T-74", title: "Why captures fail" };
const MD = "# Question\n\nWhy?\n\n## Findings\n\n- one\n- two\n\n## Recommendation\n\nDo **this**.\n\n## Appendix\n\nExtra";

function respond(get: unknown, post?: unknown) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify(post ?? { card: { id: "e1" } }), { status: 201 })
      : new Response(JSON.stringify(get), { status: get === null ? 500 : 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function open(onOpenEpic = vi.fn(), onClose = vi.fn()) {
  render(<SpikeFindingsDialog ticket={ticket} onClose={onClose} onOpenEpic={onOpenEpic} />);
  return { onOpenEpic, onClose };
}

beforeEach(() => {
  colony.sfx = vi.fn();
  colony.reduced = true;
  Element.prototype.animate = vi.fn() as never;
});
afterEach(() => vi.unstubAllGlobals());

describe("SpikeFindingsDialog", () => {
  it("shows a skeleton while loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    open();
    expect(screen.getByLabelText("Loading findings")).toBeTruthy();
    expect(screen.getByText("SPIKE COMPLETE · T-74")).toBeTruthy();
  });

  it("renders findings formatted, with the recommendation in its own block", async () => {
    respond({ found: true, markdown: MD, epicId: null });
    open();
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const rec = screen.getByLabelText("Recommendation");
    expect(rec.textContent).toContain("Do this.");
    expect(rec.textContent).not.toContain("Extra");
    expect(screen.getByText("Extra")).toBeTruthy();
    expect(screen.getByText("Make a PRD from these findings")).toBeTruthy();
  });

  it("says plainly when the findings are missing and links the PR", async () => {
    respond({ found: false, prUrl: "https://example.com/pr/1", epicId: null });
    open();
    expect(await screen.findByText(/could not be found on/)).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.com/pr/1");
    expect(screen.queryByText("Make a PRD from these findings")).toBeNull();
  });

  it("offers a retry after a fetch error", async () => {
    const f = respond(null);
    open();
    fireEvent.click(await screen.findByText("Try again"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
  });

  it("makes the Epic, shows it is working, then reads Open Epic", async () => {
    respond({ found: true, markdown: MD, epicId: null });
    const { onOpenEpic } = open();
    fireEvent.click(await screen.findByText("Make a PRD from these findings"));
    expect(await screen.findByText("Making the PRD…")).toBeTruthy();
    await waitFor(() => expect(onOpenEpic).toHaveBeenCalledWith("e1"));
    expect(screen.getByText("Open Epic")).toBeTruthy();
  });

  it("only opens an Epic that already exists", async () => {
    const f = respond({ found: true, markdown: MD, epicId: "e9" });
    const { onOpenEpic } = open();
    fireEvent.click(await screen.findByText("Open Epic"));
    expect(onOpenEpic).toHaveBeenCalledWith("e9");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, the scrim and Close, with the close cue", async () => {
    respond({ found: true, markdown: MD, epicId: null });
    const { onClose } = open();
    await screen.findByText("Close");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("presentation"));
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(colony.sfx).toHaveBeenCalledWith("close");
    expect(colony.sfx).toHaveBeenCalledWith("coin");
  });
});
