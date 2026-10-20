import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ColonyView } from "@/components/colony/colony-settings";

let ColonySection: typeof import("./colony-section").ColonySection;

// The colony settings are cached per module, so each test starts with a fresh one.
beforeEach(async () => {
  vi.resetModules();
  ({ ColonySection } = await import("./colony-section"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const first: ColonyView = {
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
};

function serve() {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return new Response(JSON.stringify({ ...first, ...body }));
      }
      return new Response(JSON.stringify(first));
    }),
  );
  return posts;
}

describe("the colony settings section", () => {
  it("will not lower the reserve below the level's floor, and says which level does", async () => {
    serve();
    render(<ColonySection />);
    expect(await screen.findByText(/Lv 3 lets you run closer to full/)).toBeTruthy();
    expect((screen.getByLabelText("Fewer reserve slots") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves a bigger colony, keeping the reserve and auto-scout", async () => {
    const posts = serve();
    render(<ColonySection />);
    fireEvent.click(await screen.findByLabelText("More agents"));
    await waitFor(() => expect(posts).toEqual([{ colonySize: 5, colonyReserve: 2, autoScout: false }]));
  });

  it("saves a bigger reserve", async () => {
    const posts = serve();
    render(<ColonySection />);
    fireEvent.click(await screen.findByLabelText("More reserve slots"));
    await waitFor(() => expect(posts).toEqual([{ colonySize: 4, colonyReserve: 3, autoScout: false }]));
  });
});
