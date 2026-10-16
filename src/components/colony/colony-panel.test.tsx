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
  it("will not lower the reserve below the level's floor, and says which level does", async () => {
    serve(view());
    render(<ColonyPanel level={1} />);
    expect(await screen.findByText(/Lv 3 lets you run closer to full/)).toBeTruthy();
    expect((screen.getByLabelText("Fewer reserve slots") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves a bigger colony", async () => {
    const posts = serve(view({ level: 2 }));
    render(<ColonyPanel level={2} />);
    fireEvent.click(await screen.findByLabelText("More agents"));
    await waitFor(() => expect(posts).toEqual([{ colonySize: 5, colonyReserve: 2, autoScout: false }]));
  });

  it("keeps auto-scouting locked until its level", async () => {
    serve(view({ level: 3 }));
    render(<ColonyPanel level={3} />);
    expect(await screen.findByText(/unlocks at Lv 8/)).toBeTruthy();
  });
});
