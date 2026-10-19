import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScoutAgentSection } from "./scout-agent-section";

const presets = [
  { id: "p1", name: "Fast scout" },
  { id: "p2", name: "Deep scout" },
];

afterEach(() => vi.unstubAllGlobals());

function setup(initial: string | null = null) {
  const fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  render(<ScoutAgentSection projectId="proj" presets={presets} initial={initial} />);
  return fetchMock;
}

describe("Scout agent picker", () => {
  it("lists the presets with Column's agent selected by default", () => {
    setup();
    const picker = screen.getByRole("combobox", { name: "Scout agent" });
    expect(picker).toHaveValue("");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Column's agent",
      "Fast scout",
      "Deep scout",
    ]);
  });

  it("saves the chosen preset id", async () => {
    const fetchMock = setup();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Scout agent" }), "p2");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ projectId: "proj", scoutPresetId: "p2" }),
      }),
    );
  });

  it("saves null when Column's agent is chosen", async () => {
    const fetchMock = setup("p1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Scout agent" }), "");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ body: JSON.stringify({ projectId: "proj", scoutPresetId: null }) }),
    );
  });
});
