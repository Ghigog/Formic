import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { EpicWinDialog, ColonyToast, RerouteToast } from "./overlays";
import type { ColonyApi } from "./colony";
import { makeCard } from "@/test/cards";

const colony = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./colony", () => ({ useColony: () => colony.current }));

function api(patch: Partial<ColonyApi>): ColonyApi {
  return {
    score: { level: 3, rank: "Forager", intoLevel: 40 },
    toast: null,
    win: null,
    closeWin: vi.fn(),
    sfx: vi.fn(),
    // Reduced motion: every beat lands at once and nothing animates.
    fx: { reducedMotion: true, ring: vi.fn(), burst: vi.fn() },
    ...patch,
  } as unknown as ColonyApi;
}

beforeEach(() => {
  // jsdom has no Web Animations.
  Element.prototype.animate = vi.fn() as never;
});

afterEach(() => {
  colony.current = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RerouteToast", () => {
  it("shows the column and the reason", () => {
    render(<RerouteToast toast={{ key: 1, to: "todo", reason: "PRD is done" }} />);
    expect(screen.getByRole("status").textContent).toContain("PRD is done");
    expect(screen.getByText("MOVED")).toBeTruthy();
  });

  it("renders nothing without a toast", () => {
    const { container } = render(<RerouteToast toast={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ColonyToast", () => {
  it("shows the toast text and the level", () => {
    colony.current = api({ toast: { text: "Level up!", key: 1 } });
    render(<ColonyToast />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Level up!");
    expect(status.textContent).toContain("3");
  });

  it("renders nothing when there is no toast", () => {
    colony.current = api({});
    const { container } = render(<ColonyToast />);
    expect(container.firstChild).toBeNull();
  });
});

describe("EpicWinDialog", () => {
  const epic = makeCard({ kind: "epic", title: "Ship the thing", status: "merged" });
  const win = {
    epic,
    tally: {
      total: 70,
      bonus: 20,
      tickets: [{ id: "t1", key: "PROT-1", title: "First ticket", mult: 1.5, pts: 50 }],
    },
  };

  async function open(patch: Partial<ColonyApi> = {}, onShowcase?: (e: unknown) => void) {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ showcase: null, canGenerateShowcase: true }),
      })),
    );
    colony.current = api({ win: win as never, ...patch });
    const view = render(<EpicWinDialog onShowcase={onShowcase as never} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    return view;
  }

  it("renders nothing without a win", () => {
    colony.current = api({});
    const { container } = render(<EpicWinDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the epic, its tally, the colony standing and the summary state", async () => {
    await open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Ship the thing")).toBeTruthy();
    expect(screen.getByText(/EPIC COMPLETE · /).textContent).toContain(epic.key);
    expect(screen.getByText("First ticket")).toBeTruthy();
    expect(screen.getByText("×1.5")).toBeTruthy();
    expect(screen.getByText("+20")).toBeTruthy();
    expect(screen.getByText("+70")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByText(/No showcase yet/)).toBeTruthy();
  });

  it("offers the showcase and closes on Keep building", async () => {
    const onShowcase = vi.fn();
    const closeWin = vi.fn();
    await open({ closeWin }, onShowcase);
    fireEvent.click(screen.getByRole("button", { name: "Open Epic" }));
    expect(closeWin).toHaveBeenCalledTimes(1);
    expect(onShowcase).toHaveBeenCalledWith(epic);
    fireEvent.click(screen.getByRole("button", { name: "Keep building" }));
    expect(closeWin).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape", async () => {
    const closeWin = vi.fn();
    await open({ closeWin });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeWin).toHaveBeenCalledTimes(1);
  });
});
