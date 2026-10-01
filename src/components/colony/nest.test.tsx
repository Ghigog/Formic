import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { XP_PER_LEVEL, levelOf, rankOf, type Score } from "@/lib/colony/game";
import { ColonyPopover } from "./nest";
import type { ColonyApi } from "./colony";

let api: ColonyApi | null = null;
vi.mock("./colony", () => ({ useColony: () => api }));

beforeAll(() => {
  // jsdom has no Web Animations; the popover animates its entrance.
  HTMLElement.prototype.animate = vi.fn();
  // Nor a canvas context: the Queen is drawn on one.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function scoreAt(earned: number): Score {
  const level = levelOf(earned);
  return { earned, points: earned, level, rank: rankOf(level), intoLevel: earned % XP_PER_LEVEL, bugs: 0, squashed: 0 };
}

function openPopoverAt(earned: number) {
  api = {
    score: scoreAt(earned),
    colonyOpen: true,
    setColonyOpen: vi.fn(),
    shape: "dot",
    color: "clay",
    bugHex: "#000",
    tryStyle: vi.fn(),
    fx: { reducedMotion: true },
  } as unknown as ColonyApi;
  render(<ColonyPopover />);
  const bar = screen.getByText(/Every style unlocked|unlocks/).nextElementSibling!.firstElementChild as HTMLElement;
  return bar.style.width;
}

describe("ColonyPopover progress bar", () => {
  it("is full once every style is unlocked, and the header keeps the level XP", () => {
    expect(openPopoverAt(11 * XP_PER_LEVEL + 20)).toBe("100%");
    expect(screen.getByText("Every style unlocked")).toBeTruthy();
    expect(screen.getByText(/570 XP earned · 20\/50 this level/)).toBeTruthy();
  });

  it("shows progress into the level before the last unlock", () => {
    expect(openPopoverAt(2 * XP_PER_LEVEL + 10)).toBe("20%");
    expect(screen.getByText(/unlocks/)).toBeTruthy();
  });
});

function stubQueens(unspent: number) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ unspent: unspent - 1 }), { status: 201 })
      : new Response(JSON.stringify({ unspent })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ColonyPopover Queens", () => {
  it("shows the icon, the count, the note and the tip", async () => {
    stubQueens(2);
    openPopoverAt(3 * XP_PER_LEVEL);
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("2"));
    expect(document.querySelector("[data-queen-icon] svg")).toBeTruthy();
    expect(screen.getByText("Unlock a queen with each level")).toBeTruthy();
    expect(screen.getByText(/Drag a Queen onto a ticket or Epic/)).toBeTruthy();
    expect(screen.getByLabelText("Drag a Queen onto a card")).toBeTruthy();
  });

  it("has no Queen to drag at 0", async () => {
    const fetchMock = stubQueens(0);
    openPopoverAt(XP_PER_LEVEL - 1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(document.querySelector("[data-queen-count]")!.textContent).toBe("0");
    expect(screen.queryByLabelText("Drag a Queen onto a card")).toBeNull();
  });

  it("places a dragged Queen on the card it is dropped on and counts down", async () => {
    const fetchMock = stubQueens(2);
    openPopoverAt(3 * XP_PER_LEVEL);
    const card = document.createElement("div");
    card.dataset.tid = "t-1";
    document.body.append(card);
    document.elementFromPoint = vi.fn(() => card);
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("2"));

    fireEvent.pointerDown(screen.getByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    expect(document.querySelector("[data-queen-image]")).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });

    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("1"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/queens",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ cardId: "t-1" }) }),
    );
    expect(document.querySelector("[data-queen-image]")).toBeNull();
    card.remove();
  });

  it("places on the Epic whose header holds the drop, and shows the 422 message", async () => {
    const message = "A draft with no tickets cannot take a Queen.";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ error: message }), { status: 422 })
        : new Response(JSON.stringify({ unspent: 2 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    openPopoverAt(3 * XP_PER_LEVEL);
    const header = document.createElement("div");
    header.dataset.tid = "e-1";
    const title = document.createElement("button");
    header.append(title);
    document.body.append(header);
    document.elementFromPoint = vi.fn(() => title);
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("2"));

    fireEvent.pointerDown(screen.getByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(fetchMock).toHaveBeenCalledWith("/api/queens", expect.objectContaining({ body: JSON.stringify({ cardId: "e-1" }) }));
    expect(document.querySelector("[data-queen-count]")!.textContent).toBe("2");
    header.remove();
  });
});
