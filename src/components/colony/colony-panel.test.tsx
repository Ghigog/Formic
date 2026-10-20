import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ColonyPanel } from "./colony-panel";
import type { ColonyView } from "./colony-settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view(patch: Partial<ColonyView> = {}): ColonyView {
  return {
    colonySize: 4,
    colonyReserve: 2,
    autoScout: false,
    level: 1,
    floor: 2,
    nextFloorLevel: 3,
    maxScouts: 2,
    nextScoutLevel: 4,
    autoScoutLevel: 8,
    maxColony: 12,
    inUse: 1,
    ...patch,
  };
}

function serve(first: ColonyView) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Partial<ColonyView>;
        posts.push(body);
        return new Response(JSON.stringify({ ...first, ...body }));
      }
      return new Response(JSON.stringify(first));
    }),
  );
  return posts;
}

describe("the colony panel", () => {
  it("shows a disabled Auto-scout that says when it unlocks, and no cap controls", async () => {
    serve(view({ level: 3 }));
    render(<ColonyPanel level={3} />);
    const button = (await screen.findByRole("button", { name: /Auto-scout/ })) as HTMLButtonElement;
    expect(button.textContent).toMatch(/unlocks at Lv 8/);
    expect(button.disabled).toBe(true);
    expect(screen.queryByLabelText("More agents")).toBeNull();
    expect(screen.queryByText(/Cap how many agents run/)).toBeNull();
  });

  it("needs a cap before it can be turned on", async () => {
    serve(view({ level: 8, colonySize: null }));
    render(<ColonyPanel level={8} />);
    const button = (await screen.findByRole("button", { name: /Auto-scout/ })) as HTMLButtonElement;
    expect(button.textContent).toMatch(/Settings/);
    expect(button.disabled).toBe(true);
  });

  it("saves auto-scout on when unlocked and capped", async () => {
    const posts = serve(view({ level: 8 }));
    render(<ColonyPanel level={8} />);
    fireEvent.click(await screen.findByRole("button", { name: /Auto-scout/ }));
    await waitFor(() => expect(posts).toEqual([{ colonySize: 4, colonyReserve: 2, autoScout: true }]));
    await waitFor(() => expect(screen.getByRole("button", { name: /Auto-scout/ }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("shows the scout and reserve caps the level allows", async () => {
    serve(view({ level: 3, floor: 1, nextFloorLevel: 6, colonyReserve: 1 }));
    render(<ColonyPanel level={3} />);
    await screen.findByText("Up to 2 per ticket · Lv 4 allows 3");
    expect(document.querySelector("[data-scout-cap]")!.textContent).toBe("2");
    expect(document.querySelector("[data-reserve-cap]")!.textContent).toBe("1");
    expect(screen.getByText("1 of 4 slots kept for urgent work")).toBeTruthy();
    expect(screen.getByText("At least 1 at Lv 3 · Lv 6 lowers it")).toBeTruthy();
  });

  it("says the reserve is off with no colony cap", async () => {
    serve(view({ colonySize: null, colonyReserve: 0 }));
    render(<ColonyPanel level={1} />);
    await screen.findByText("No colony cap · set one in Settings");
    expect(document.querySelector("[data-reserve-cap]")!.textContent).toBe("off");
  });

  it("opens each tip when pressed and closes it on a second press", async () => {
    serve(view());
    render(<ColonyPanel level={1} />);
    const scouts = await screen.findByRole("button", { name: "How scouts work" });
    fireEvent.click(scouts);
    expect(screen.getByRole("tooltip").textContent).toMatch(/Reviewer picks the best/);
    fireEvent.click(scouts);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How the colony reserve works" }));
    expect(screen.getByRole("tooltip").textContent).toMatch(/routine work may not use/);
  });
});
