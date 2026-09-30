import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunTimeBudgetSection } from "./run-time-budget-section";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("RunTimeBudgetSection", () => {
  it("selects per story point by default and states the 10 minute default", () => {
    render(<RunTimeBudgetSection />);
    expect(screen.getByRole("radio", { name: /Per story point/ })).toBeChecked();
    expect(screen.getByText(/10 minutes per story point/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Minutes per ticket")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
  });

  it("shows the flat input only in flat mode and the table only in per-point mode", async () => {
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /Flat minutes/ }));
    expect(screen.getByLabelText("Minutes per ticket")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();

    await user.click(screen.getByRole("radio", { name: /Per-point values/ }));
    expect(screen.queryByLabelText("Minutes per ticket")).toBeNull();
    expect(screen.getByRole("button", { name: "Add row" })).toBeInTheDocument();
  });

  it("sends flat minutes and confirms the save", async () => {
    const fetchMock = stubFetch(Response.json({ mode: "FLAT_MINUTES", flatMinutes: 30 }));
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /Flat minutes/ }));
    await user.type(screen.getByLabelText("Minutes per ticket"), "30");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ mode: "FLAT_MINUTES", flatMinutes: 30, perPointMinutes: null }),
      }),
    );
    expect(await screen.findByText("Run time budget saved.")).toBeInTheDocument();
  });

  it("shows a saved flat value on load", () => {
    render(<RunTimeBudgetSection initial={{ mode: "FLAT_MINUTES", flatMinutes: 30 }} />);
    expect(screen.getByRole("radio", { name: /Flat minutes/ })).toBeChecked();
    expect(screen.getByLabelText("Minutes per ticket")).toHaveValue("30");
  });

  it("blocks the request and shows an inline error for an empty per-point table", async () => {
    const fetchMock = stubFetch(Response.json({}));
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /Per-point values/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Add at least one per-point value.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks flat minutes below 1", async () => {
    const fetchMock = stubFetch(Response.json({}));
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /Flat minutes/ }));
    await user.type(screen.getByLabelText("Minutes per ticket"), "0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText(/at least 1/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the API's field error next to the field", async () => {
    stubFetch(
      Response.json(
        { error: "Invalid run time budget.", errors: { flatMinutes: "Too long for this plan." } },
        { status: 400 },
      ),
    );
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /Flat minutes/ }));
    await user.type(screen.getByLabelText("Minutes per ticket"), "30");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Too long for this plan.")).toBeInTheDocument();
    expect(screen.getByLabelText("Minutes per ticket")).toHaveAccessibleDescription("Too long for this plan.");
    expect(screen.queryByText("Run time budget saved.")).toBeNull();
  });
});
