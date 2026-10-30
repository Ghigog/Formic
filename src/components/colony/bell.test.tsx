import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const struck = vi.hoisted(() => [] as number[]);
vi.mock("./bell-sound", () => ({
  primeBell: () => {},
  strikeBell: (strength = 1) => struck.push(strength),
}));

import { Bell } from "./bell";

type State = { left: number; armed: boolean };
let state: State;
let posts: string[];

beforeEach(() => {
  struck.length = 0;
  posts = [];
  state = { left: 0, armed: false };
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json(state);
      const action = JSON.parse(init.body as string).action as string;
      posts.push(action);
      if (action === "ring") return Response.json({ ...state, sent: 3, skipped: 0 });
      state = { ...state, armed: action === "arm" };
      return Response.json(state);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const cord = () => screen.getByRole("button", { name: /bell cord/i });

/** Grabs the cord and swings it: each x is where the hand goes next. */
function swingCord(xs: number[]) {
  fireEvent.pointerDown(cord(), { pointerId: 1, clientX: 100, clientY: 100 });
  for (const x of xs) fireEvent.pointerMove(cord(), { pointerId: 1, clientX: x, clientY: 104 });
  fireEvent.pointerUp(cord(), { pointerId: 1, clientX: xs.at(-1) ?? 100, clientY: 104 });
}

describe("the bell", () => {
  it("rings with a full swing of the cord at any level, sounds, and says what it did", async () => {
    render(<Bell />);
    await screen.findByText(/0 golden bells left/);
    swingCord([130, 70, 130]);
    await waitFor(() => expect(posts).toEqual(["ring"]));
    expect(struck[0]).toBe(1);
    expect(await screen.findByText("Rang. Told 3 cards to carry on.")).toBeTruthy();
  });

  it("does nothing but sway on a tap of the cord, so a misclick never rings it", async () => {
    render(<Bell />);
    await screen.findByText(/0 golden bells left/);
    swingCord([]);
    fireEvent.click(cord());
    swingCord([108, 95, 104]);
    expect(posts).toEqual([]);
    expect(struck).toEqual([]);
  });

  it("rings from the keyboard by swinging with the arrow keys", async () => {
    render(<Bell />);
    await screen.findByText(/0 golden bells left/);
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowRight"]) fireEvent.keyDown(cord(), { key });
    await waitFor(() => expect(posts).toEqual(["ring"]));
  });

  it("arms a golden bell when the bell itself is tapped, and turns gold", async () => {
    state = { left: 2, armed: false };
    render(<Bell />);
    await screen.findByText(/2 golden bells left/);
    fireEvent.click(screen.getByRole("button", { name: /tap to arm a golden bell/i }));
    await waitFor(() => expect(posts).toEqual(["arm"]));
    expect(await screen.findByText("Golden bell")).toBeTruthy();
    expect(screen.getByTestId("bell-rig")).toHaveAttribute("data-armed");
    expect(screen.getByRole("button", { name: /armed/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("explains there is no golden bell yet, without arming, when none are left", async () => {
    render(<Bell />);
    await screen.findByText(/0 golden bells left/);
    fireEvent.click(screen.getByRole("button", { name: /tap to arm a golden bell/i }));
    expect(await screen.findByText(/one comes every five levels/)).toBeTruthy();
    expect(posts).toEqual([]);
  });
});
