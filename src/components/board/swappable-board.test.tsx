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
  mounts.count = 0;
  calls = [];
  swapResponse = (id) => Response.json({ project: { id }, board: props(id.toUpperCase()) });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/projects") return Response.json({ projects: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    if (url === "/api/projects/swap") return swapResponse(JSON.parse(init!.body as string).projectId);
    return Response.json({ ok: true });
  });
});
afterEach(() => vi.unstubAllGlobals());

const renderBoard = () => render(<SwappableBoard account={account} projectId="a" board={props("A")} />);
const swapDown = () => fireEvent.keyDown(screen.getByText("A"), { key: "ArrowDown", altKey: true });
const opened = () => calls.filter((c) => c.url === "/api/projects/opened");

describe("SwappableBoard", () => {
  it("swaps down to the next board, remounted, without recording it as opened", async () => {
    renderBoard();
    swapDown();
    expect(await screen.findByText("B")).toBeTruthy();
    expect(mounts.count).toBe(2);
    expect(opened()).toHaveLength(0);
  });

  it("swaps back up to the board it came from, using the frozen order", async () => {
    renderBoard();
    swapDown();
    await screen.findByText("B");
    fireEvent.keyDown(screen.getByText("B"), { key: "ArrowUp", altKey: true });
    expect(await screen.findByText("A")).toBeTruthy();
    expect(calls.filter((c) => c.url === "/api/projects")).toHaveLength(1);
  });

  it("records the board in view as opened once, when something else is touched", async () => {
    renderBoard();
    swapDown();
    await screen.findByText("B");
    fireEvent.pointerDown(screen.getByText("open card"));
    fireEvent.keyDown(screen.getByText("open card"), { key: "Enter" });
    expect(opened()).toEqual([{ url: "/api/projects/opened", body: { projectId: "b" } }]);
  });

  it("bounces and stays on the last board", async () => {
    renderBoard();
    const down = (name: string) => fireEvent.keyDown(screen.getByText(name), { key: "ArrowDown", altKey: true });
    down("A");
    await screen.findByText("B");
    down("B");
    await screen.findByText("C");
    down("C");
    await waitFor(() => expect(document.querySelector("[data-slide=bounce]")).toBeTruthy());
    expect(screen.getByText("C")).toBeTruthy();
    expect(calls.filter((c) => c.url === "/api/projects/swap")).toHaveLength(2);
  });

  it("stays on the previous board and shows an error toast when the next fails to load", async () => {
    swapResponse = () => Response.json({ error: "x" }, { status: 500 });
    renderBoard();
    swapDown();
    expect((await screen.findByRole("alert")).textContent).toMatch(/previous one/);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.queryByTestId("dirt-band")).toBeNull();
  });
});
