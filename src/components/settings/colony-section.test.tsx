import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  colonyMode: "manual",
  autoSize: 2,
  autoReserve: 0,
  nextAutoLevel: 2,
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

function serve(start: ColonyView = first) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return new Response(JSON.stringify({ ...start, ...body }));
      }
      return new Response(JSON.stringify(start));
    }),
  );
  return posts;
}

describe("the colony settings section", () => {
  it("will not lower the reserve below the level's floor, and says which level does", async () => {
    serve();
    render(<ColonySection />);
    expect(
      await screen.findByText(/Lv 3 lets you run closer to full/),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Fewer reserve slots") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("saves a bigger colony, keeping the reserve and auto-scout", async () => {
    const posts = serve();
    render(<ColonySection />);
    fireEvent.click(await screen.findByLabelText("More agents"));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          colonyMode: "manual",
          colonySize: 5,
          colonyReserve: 2,
          autoScout: false,
        },
      ]),
    );
  });

  it("saves a bigger reserve", async () => {
    const posts = serve();
    render(<ColonySection />);
    fireEvent.click(await screen.findByLabelText("More reserve slots"));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          colonyMode: "manual",
          colonySize: 4,
          colonyReserve: 3,
          autoScout: false,
        },
      ]),
    );
  });

  const auto: ColonyView = {
    ...first,
    colonyMode: "auto",
    colonySize: null,
    colonyReserve: 0,
    autoSize: 4,
    autoReserve: 1,
    nextAutoLevel: 4,
    level: 3,
    floor: 1,
  };

  it("shows Automatic with the level's cap and no steppers", async () => {
    serve(auto);
    render(<ColonySection />);
    expect(
      await screen.findByText(/4 agents at once, 1 kept for bugs and fixes/),
    ).toBeTruthy();
    expect(screen.getByText(/Lv 4 runs 5/)).toBeTruthy();
    expect(
      (screen.getByLabelText("Automatic") as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByLabelText("More agents")).toBeNull();
  });

  it("says none kept below a cap of 4, and steady at the top", async () => {
    serve({ ...auto, autoSize: 8, autoReserve: 1, nextAutoLevel: null });
    render(<ColonySection />);
    expect(await screen.findByText(/Steady at 8/)).toBeTruthy();
    cleanup();
    vi.resetModules();
    ({ ColonySection } = await import("./colony-section"));
    serve({ ...auto, autoSize: 3, autoReserve: 0 });
    render(<ColonySection />);
    expect(await screen.findByText(/3 agents at once, none kept/)).toBeTruthy();
  });

  it("switching Automatic to Set my own starts from the automatic numbers", async () => {
    const posts = serve(auto);
    render(<ColonySection />);
    fireEvent.click(await screen.findByLabelText("Set my own"));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          colonyMode: "manual",
          colonySize: 4,
          colonyReserve: 1,
          autoScout: false,
        },
      ]),
    );
    expect(screen.getByLabelText("agents").textContent).toBe("4");
    expect(screen.getByLabelText("reserve slots").textContent).toBe("1");
  });

  it("lets Set my own go up to the manual ceiling", async () => {
    serve({ ...first, colonySize: 12 });
    render(<ColonySection />);
    expect(
      ((await screen.findByLabelText("More agents")) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByLabelText("agents").textContent).toBe("12");
  });

  it("switching to Off saves it and shows the file-reservations line", async () => {
    const posts = serve(auto);
    render(<ColonySection />);
    fireEvent.click(await screen.findByLabelText("Off"));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          colonyMode: "off",
          colonySize: null,
          colonyReserve: 0,
          autoScout: false,
        },
      ]),
    );
    expect(
      await screen.findByText("Off: only file reservations hold work back."),
    ).toBeTruthy();
  });

  it("switching from Set my own back to Automatic saves the mode", async () => {
    const posts = serve();
    render(<ColonySection />);
    fireEvent.click(await screen.findByLabelText("Automatic"));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          colonyMode: "auto",
          colonySize: null,
          colonyReserve: 2,
          autoScout: false,
        },
      ]),
    );
  });
});
