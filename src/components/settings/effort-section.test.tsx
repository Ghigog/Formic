import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffortSection } from "./effort-section";

afterEach(() => vi.unstubAllGlobals());

describe("EffortSection", () => {
  it("is on by default", () => {
    render(<EffortSection />);
    expect(screen.getByLabelText("Match effort to story points")).toBeChecked();
  });

  it("saves the switch", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ effortByPoints: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<EffortSection initial />);
    await userEvent.setup().click(screen.getByLabelText("Match effort to story points"));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ effortByPoints: false });
    expect(screen.getByLabelText("Match effort to story points")).not.toBeChecked();
  });

  it("says when it did not save, and stays as it was", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
    render(<EffortSection initial />);
    await userEvent.setup().click(screen.getByLabelText("Match effort to story points"));
    expect(await screen.findByRole("alert")).toHaveTextContent("did not save");
    expect(screen.getByLabelText("Match effort to story points")).toBeChecked();
  });
});
