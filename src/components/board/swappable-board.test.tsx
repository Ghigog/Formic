import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SwappableBoard } from "./swappable-board";
import type { BoardProps } from "@/lib/board/board-props";

/** The shell is stubbed: what matters here is which board's props it is given and when it remounts. */
const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("./board-shell", async () => {
  const React = await import("react");
  return {
    BoardShell: ({ projectName }: { projectName: string }) => {
      React.useEffect(() => {
        mounts.count++;
      }, []);
      return (
        <div>
          <span>{projectName}</span>
          <button>open card</button>
        </div>
      );
    },
  };
});

const account = { login: "u", name: "U", avatarUrl: null, signedIn: false };
const props = (name: string) => ({ projectName: name }) as unknown as BoardProps;

let calls: Array<{ url: string; body?: unknown }>;
let swapResponse: (id: string) => Response;

beforeEach(() => {
  // Reduced motion keeps the dig short: the transition has its own tests.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query }));
  mounts.count = 0;
  calls = [];
  swapResponse = (id) => Response.json({ project: { id }, board: props(id.toUpperCase()) });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/projects") return Response.json({ projects: [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }, { id: "c", name: "Charlie" }] });
    if (url === "/api/projects/swap") return swapResponse(JSON.parse(init!.body as string).projectId);
    return Response.json({ ok: true });
  });
});
afterEach(() => vi.unstubAllGlobals());

const renderBoard = () => render(<SwappableBoard account={account} projectId="a" board={props("A")} />);
const stage = () => screen.getByTestId("dig-transition").parentElement!;
const fingers = (y: number) => [0, 20, 40].map((x) => ({ clientX: 100 + x, clientY: y, identifier: x }));

/** A three-finger swipe on the board: up digs down to the next board, down goes back. */
function swipe(direction: "down" | "up") {
  const [from, to] = direction === "down" ? [400, 250] : [250, 400];
  fireEvent.touchStart(stage(), { touches: fingers(from) });
  fireEvent.touchMove(stage(), { touches: fingers((from + to) / 2) });
  fireEvent.touchEnd(stage(), { touches: [], changedTouches: fingers(to) });
}
const opened = () => calls.filter((c) => c.url === "/api/projects/opened");
const toLoad = { timeout: 3000 };

describe("SwappableBoard", () => {
  it("has no swap handle and no keyboard shortcut: the gestures are the way", () => {
    renderBoard();
    expect(screen.queryByRole("button", { name: /swap board/i })).toBeNull();
    fireEvent.keyDown(screen.getByText("A"), { key: "ArrowDown", altKey: true });
    expect(calls.filter((c) => c.url === "/api/projects/swap")).toHaveLength(0);
  });

  it("digs down to the next board on a three-finger swipe up, remounted, without recording it as opened", async () => {
    renderBoard();
    swipe("down");
    expect(await screen.findByText("B", undefined, toLoad)).toBeTruthy();
    expect(mounts.count).toBe(2);
    expect(opened()).toHaveLength(0);
  });

  it("goes back up to the board it came from, using the frozen order", async () => {
    renderBoard();
    swipe("down");
    await screen.findByText("B", undefined, toLoad);
    await waitFor(() => expect(screen.getByTestId("dig-transition").dataset.phase).toBe("idle"), toLoad);
    swipe("up");
    expect(await screen.findByText("A", undefined, toLoad)).toBeTruthy();
    expect(calls.filter((c) => c.url === "/api/projects")).toHaveLength(1);
  });

  it("swaps on a right-button drag upward, and holds back the context menu that drag would open", async () => {
    renderBoard();
    fireEvent.pointerDown(stage(), { button: 2, clientX: 100, clientY: 400 });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    stage().dispatchEvent(menu);
    fireEvent.pointerMove(window, { clientX: 100, clientY: 320 });
    fireEvent.pointerUp(window, { button: 2, clientX: 100, clientY: 250 });
    expect(menu.defaultPrevented).toBe(true);
    expect(await screen.findByText("B", undefined, toLoad)).toBeTruthy();
  });

  it("records the board in view as opened once, when something else is clicked or typed", async () => {
    renderBoard();
    swipe("down");
    await screen.findByText("B", undefined, toLoad);
    await waitFor(() => expect(screen.getByTestId("dig-transition").dataset.phase).toBe("idle"), toLoad);
    fireEvent.click(screen.getByText("open card"));
    fireEvent.keyDown(screen.getByText("open card"), { key: "Enter" });
    expect(opened()).toEqual([{ url: "/api/projects/opened", body: { projectId: "b" } }]);
  });

  it("bounces and stays on the last board", async () => {
    renderBoard();
    const idle = () => waitFor(() => expect(screen.getByTestId("dig-transition").dataset.phase).toBe("idle"), toLoad);
    swipe("down");
    await screen.findByText("B", undefined, toLoad);
    await idle();
    swipe("down");
    await screen.findByText("C", undefined, toLoad);
    await idle();
    swipe("down");
    await waitFor(() => expect(screen.getByTestId("dig-transition").dataset.phase).toBe("bouncing"));
    expect(screen.getByText("C")).toBeTruthy();
    expect(calls.filter((c) => c.url === "/api/projects/swap")).toHaveLength(2);
  });

  it("comes back to the previous board and shows an error when the next fails to load", async () => {
    swapResponse = () => Response.json({ error: "x" }, { status: 500 });
    renderBoard();
    swipe("down");
    expect((await screen.findByRole("alert", undefined, toLoad)).textContent).toMatch(/previous one/);
    expect(screen.getByText("A")).toBeTruthy();
  });
});
