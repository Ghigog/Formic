import { QUEEN_TOUCH_OFFSET_Y } from "./queen-carry";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { XP_PER_LEVEL, levelOf, rankOf, type Score } from "@/lib/colony/game";
import { ColonyPopover } from "./nest";
import type { ColonyApi } from "./colony";
import { resetViewport, setViewportMatches } from "@/test/viewport";

let api: ColonyApi | null = null;
vi.mock("./colony", () => ({ useColony: () => api }));

beforeAll(() => {
  // jsdom has no Web Animations; the popover animates its entrance.
  HTMLElement.prototype.animate = vi.fn();
  // Nor a canvas context: the Queen is drawn on one.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

// jsdom has no elementFromPoint; tests assign it, so put it back afterwards.
const originalElementFromPoint = document.elementFromPoint;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.elementFromPoint = originalElementFromPoint;
});

function scoreAt(earned: number): Score {
  const level = levelOf(earned);
  return { earned, points: earned, level, rank: rankOf(level), intoLevel: earned % XP_PER_LEVEL, bugs: 0, squashed: 0 };
}

function openPopoverAt(earned: number, onOpenArchive?: () => void) {
  api = {
    score: scoreAt(earned),
    colonyOpen: true,
    setColonyOpen: vi.fn(),
    shape: "dot",
    color: "clay",
    bugHex: "#000",
    tryStyle: vi.fn(),
    fx: { reducedMotion: true },
    sfx: vi.fn(),
  } as unknown as ColonyApi;
  render(<ColonyPopover onOpenArchive={onOpenArchive} />);
  const bar = screen.getByText(/Everything unlocked|unlocks/).nextElementSibling!.firstElementChild as HTMLElement;
  return bar.style.width;
}

describe("ColonyPopover progress bar", () => {
  it("is full once everything is unlocked, and the header keeps the level XP", () => {
    expect(openPopoverAt(33 * XP_PER_LEVEL + 20)).toBe("100%");
    expect(screen.getByText("Everything unlocked")).toBeTruthy();
    expect(screen.getByText(/1,?670 XP earned · 20\/50 this level/)).toBeTruthy();
  });

  it("shows progress into the level before the last unlock", () => {
    expect(openPopoverAt(2 * XP_PER_LEVEL + 10)).toBe("20%");
    expect(screen.getByText(/unlocks/)).toBeTruthy();
  });
});

describe("ColonyPopover Archived", () => {
  it("closes the popover and opens the Archived view", () => {
    const onOpenArchive = vi.fn();
    openPopoverAt(10, onOpenArchive);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(api!.setColonyOpen).toHaveBeenCalledWith(false);
    expect(onOpenArchive).toHaveBeenCalledTimes(1);
  });

  it("has no Archived button without onOpenArchive", () => {
    openPopoverAt(10);
    expect(screen.queryByRole("button", { name: "Archived" })).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "How Queens work" }));
    expect(screen.getByRole("tooltip").textContent).toMatch(/Drop a Queen on a ticket and the ants work through every ticket it needs/);
    expect(screen.getByLabelText("Drag a Queen onto a card")).toBeTruthy();
  });

  it("scrolls within the viewport on a short screen", () => {
    stubQueens(2);
    openPopoverAt(3 * XP_PER_LEVEL);
    const cls = document.querySelector<HTMLElement>("[role=dialog]")!.className;
    expect(cls).toContain("max-h-[calc(100dvh-5rem)]");
    expect(cls).toContain("overflow-y-auto");
    expect(cls).toContain("overscroll-contain");
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

  it("draws a touch-dragged Queen below the finger and drops on the card under the finger", async () => {
    stubQueens(1);
    openPopoverAt(3 * XP_PER_LEVEL);
    const card = document.createElement("div");
    card.dataset.tid = "t-1";
    document.body.append(card);
    const lookup = vi.fn(() => card);
    document.elementFromPoint = lookup;
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("1"));

    fireEvent.pointerDown(screen.getByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 100, clientY: 200, pointerType: "touch" });
    const image = document.querySelector<HTMLElement>("[data-queen-image]")!;
    expect(image.style.left).toBe("100px");
    expect(image.style.top).toBe(`${200 + QUEEN_TOUCH_OFFSET_Y}px`);
    fireEvent.pointerUp(window, { clientX: 100, clientY: 200, pointerType: "touch" });
    expect(lookup).toHaveBeenCalledWith(100, 200);
    card.remove();
  });

  it("keeps a mouse-dragged Queen on the pointer", async () => {
    stubQueens(1);
    openPopoverAt(3 * XP_PER_LEVEL);
    document.elementFromPoint = vi.fn(() => document.body);
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("1"));

    fireEvent.pointerDown(screen.getByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 100, clientY: 200, pointerType: "mouse" });
    const image = document.querySelector<HTMLElement>("[data-queen-image]")!;
    expect(image.style.top).toBe("200px");
    fireEvent.pointerUp(window, { clientX: 100, clientY: 200, pointerType: "mouse" });
    expect(document.elementFromPoint).toHaveBeenCalledWith(100, 200);
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

describe("ColonyPopover Queen carry", () => {
  const carryEvents: boolean[] = [];
  const onCarry = (e: Event) => carryEvents.push((e as CustomEvent<{ on: boolean }>).detail.on);

  function dragAndDrop(mobile: boolean) {
    setViewportMatches(mobile);
    carryEvents.length = 0;
    window.addEventListener("formic:queen-carry", onCarry);
    const fetchMock = stubQueens(2);
    openPopoverAt(3 * XP_PER_LEVEL);
    return fetchMock;
  }

  afterEach(() => {
    window.removeEventListener("formic:queen-carry", onCarry);
    resetViewport();
  });

  it("hides the dialog and backdrop on a phone while carrying, then closes the menu on a drop and still places", async () => {
    const fetchMock = dragAndDrop(true);
    const card = document.createElement("div");
    card.dataset.tid = "t-9";
    document.body.append(card);
    document.elementFromPoint = vi.fn(() => card);
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("2"));

    fireEvent.pointerDown(screen.getByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.className).toContain("invisible");
    expect(dialog.previousElementSibling!.className).toContain("invisible");
    expect(document.querySelector("[data-queen-image]")).toBeTruthy();
    expect(carryEvents).toEqual([true]);

    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/queens", expect.objectContaining({ body: JSON.stringify({ cardId: "t-9" }) })),
    );
    expect(api!.setColonyOpen).toHaveBeenCalledWith(false);
    expect(carryEvents).toEqual([true, false]);
    card.remove();
  });

  it("closes the menu on desktop after a drop on a card and still places", async () => {
    const fetchMock = dragAndDrop(false);
    const card = document.createElement("div");
    card.dataset.tid = "t-9";
    document.body.append(card);
    document.elementFromPoint = vi.fn(() => card);
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("2"));

    fireEvent.pointerDown(screen.getByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });

    expect(api!.setColonyOpen).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/queens", expect.objectContaining({ body: JSON.stringify({ cardId: "t-9" }) })),
    );
    card.remove();
  });

  it("keeps the menu open when the drop is over nothing or cancelled", async () => {
    const fetchMock = dragAndDrop(false);
    document.elementFromPoint = vi.fn(() => document.body);
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("2"));
    const queen = screen.getByLabelText("Drag a Queen onto a card");

    fireEvent.pointerDown(queen, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
    fireEvent.pointerDown(queen, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerCancel(window);

    expect(api!.setColonyOpen).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps the drag image out of any hidden ancestor on a phone while carrying", async () => {
    dragAndDrop(true);
    document.elementFromPoint = vi.fn(() => null);
    await waitFor(() => expect(document.querySelector("[data-queen-count]")!.textContent).toBe("2"));
    fireEvent.pointerDown(screen.getByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    const image = document.querySelector<HTMLElement>("[data-queen-image]")!;
    expect(image).toBeTruthy();
    for (let el: HTMLElement | null = image; el; el = el.parentElement) expect(el.className).not.toContain("invisible");
    expect(document.querySelector("[role=dialog]")!.contains(image)).toBe(false);
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
  });

  it("leaves the dialog visible on desktop while carrying", async () => {
    dragAndDrop(false);
    document.elementFromPoint = vi.fn(() => document.body);
    await screen.findByLabelText("Drag a Queen onto a card");
    fireEvent.pointerDown(screen.getByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    expect(document.querySelector("[role=dialog]")!.className).not.toContain("invisible");
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
  });
});

describe("ColonyPopover Queen sounds", () => {
  function carry(overCard: boolean, post: Response) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? post : new Response(JSON.stringify({ unspent: 2 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    openPopoverAt(3 * XP_PER_LEVEL);
    const sfx = vi.fn();
    api!.sfx = sfx;
    const card = document.createElement("div");
    card.dataset.tid = "t-1";
    document.body.append(card);
    document.elementFromPoint = vi.fn(() => (overCard ? card : document.body));
    return { sfx, fetchMock, card };
  }

  it("skitters as the carried Queen moves far enough, and not on a tiny nudge", async () => {
    const { sfx, card } = carry(true, new Response("{}", { status: 201 }));
    fireEvent.pointerDown(await screen.findByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 7, clientY: 5 });
    expect(sfx).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { clientX: 60, clientY: 5 });
    expect(sfx).toHaveBeenCalledWith("skitter", expect.any(Number));
    fireEvent.pointerUp(window, { clientX: 60, clientY: 5 });
    card.remove();
  });

  it("squashes on the drop over a card, before the answer", async () => {
    const { sfx, card } = carry(true, new Response("{}", { status: 201 }));
    fireEvent.pointerDown(await screen.findByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
    expect(sfx).toHaveBeenCalledWith("squash");
    expect(sfx).not.toHaveBeenCalledWith("reject");
    card.remove();
  });

  it("plays reject when the placement is refused", async () => {
    const { sfx, card } = carry(true, new Response(JSON.stringify({ error: "No." }), { status: 422 }));
    fireEvent.pointerDown(await screen.findByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
    await waitFor(() => expect(sfx).toHaveBeenCalledWith("reject"));
    card.remove();
  });

  it("plays no squash on a drop over nothing", async () => {
    const { sfx, fetchMock, card } = carry(false, new Response("{}", { status: 201 }));
    fireEvent.pointerDown(await screen.findByLabelText("Drag a Queen onto a card"), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
    expect(sfx).not.toHaveBeenCalledWith("squash");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/queens", expect.objectContaining({ method: "POST" }));
    card.remove();
  });
});

describe("ColonyPopover bell", () => {
  function bellWith(state: { left: number; armed: boolean }) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const action = init?.method === "POST" ? JSON.parse(init.body as string).action : null;
      if (action === "arm") return new Response(JSON.stringify({ left: state.left, armed: true }));
      return new Response(JSON.stringify(state));
    });
    vi.stubGlobal("fetch", fetchMock);
    openPopoverAt(11 * XP_PER_LEVEL);
    return fetchMock;
  }
  const posts = (m: ReturnType<typeof bellWith>) =>
    m.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init!.body as string).action);

  it("shows the golden bells left", async () => {
    bellWith({ left: 2, armed: false });
    expect(await screen.findByText("2 golden bells left")).toBeTruthy();
  });

  it("rings when dragged side to side", async () => {
    const m = bellWith({ left: 2, armed: false });
    const bell = await screen.findByLabelText("Bell");
    await waitFor(() => expect((bell as HTMLButtonElement).disabled).toBe(false));
    fireEvent.pointerDown(bell, { clientX: 100 });
    for (const x of [130, 100, 130]) fireEvent.pointerMove(bell, { clientX: x });
    fireEvent.pointerUp(bell, { clientX: 130 });
    fireEvent.click(bell);
    await waitFor(() => expect(posts(m)).toEqual(["ring"]));
  });

  it("arms on a plain click without ringing", async () => {
    const m = bellWith({ left: 2, armed: false });
    const bell = await screen.findByLabelText("Bell");
    await waitFor(() => expect((bell as HTMLButtonElement).disabled).toBe(false));
    fireEvent.pointerDown(bell, { clientX: 100 });
    fireEvent.pointerUp(bell, { clientX: 100 });
    fireEvent.click(bell);
    await waitFor(() => expect(bell.getAttribute("aria-pressed")).toBe("true"));
    expect(posts(m)).toEqual(["arm"]);
  });

  it("stays silver when none are left", async () => {
    const m = bellWith({ left: 0, armed: false });
    const bell = await screen.findByLabelText("Bell");
    await screen.findByText("0 golden bells left");
    fireEvent.click(bell);
    expect(bell.getAttribute("aria-pressed")).toBe("false");
    expect(posts(m)).toEqual([]);
  });
});
