import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunTimeBudgetSection } from "./run-time-budget-section";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const axis = (name: string) => within(screen.getByRole("group", { name }));
const sentBody = (fetchMock: ReturnType<typeof stubFetch>) =>
  JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);

describe("RunTimeBudgetSection", () => {
  it("shows time, tokens and attempts, each with its enforcement class", () => {
    render(<RunTimeBudgetSection />);
    for (const name of ["Time", "Tokens", "Attempts"]) {
      expect(axis(name).getByRole("radio", { name: "Off" })).toBeInTheDocument();
      expect(axis(name).getByRole("radio", { name: "Flat" })).toBeInTheDocument();
      expect(axis(name).getByRole("radio", { name: "Per point" })).toBeInTheDocument();
      expect(axis(name).getByRole("radio", { name: "Per point by hand" })).toBeInTheDocument();
      expect(axis(name).getByText(/^Enforcement:/)).toBeInTheDocument();
    }
    expect(axis("Time").getByRole("radio", { name: "Per point" })).toBeChecked();
    expect(axis("Time").getByText(/10 minutes per story point/)).toBeInTheDocument();
    expect(axis("Tokens").getByRole("radio", { name: "Per point" })).toBeChecked();
    expect(axis("Attempts").getByRole("radio", { name: "Flat" })).toBeChecked();
  });

  it("offers no money field", () => {
    render(<RunTimeBudgetSection />);
    expect(screen.queryByText(/money|cents|dollar|\$/i)).toBeNull();
  });

  it.each(["Time", "Tokens", "Attempts"])("names the hard rail when %s is Off", async (name) => {
    render(<RunTimeBudgetSection />);
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.setup().click(axis(name).getByRole("radio", { name: "Off" }));
    expect(axis(name).getByRole("note")).toHaveTextContent(/hard rail.*sandbox 20 minutes/);
  });

  it("shows the flat input only in flat mode and the table only in by-hand mode", async () => {
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(axis("Time").getByRole("radio", { name: "Flat" }));
    expect(axis("Time").getByLabelText("Minutes per ticket")).toBeInTheDocument();
    expect(axis("Time").queryByRole("button", { name: "Add row" })).toBeNull();

    await user.click(axis("Time").getByRole("radio", { name: "Per point by hand" }));
    expect(axis("Time").queryByLabelText("Minutes per ticket")).toBeNull();
    expect(axis("Time").getByRole("button", { name: "Add row" })).toBeInTheDocument();
  });

  it("lets tokens set their per-point rate", async () => {
    render(<RunTimeBudgetSection tokens={{ mode: "PER_POINT", perPoint: 50_000 }} />);
    expect(axis("Tokens").getByLabelText("Tokens per story point")).toHaveValue("50000");
  });

  it("sends every axis and confirms the save", async () => {
    const fetchMock = stubFetch(Response.json({}));
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(axis("Time").getByRole("radio", { name: "Flat" }));
    await user.type(axis("Time").getByLabelText("Minutes per ticket"), "30");
    await user.click(axis("Tokens").getByRole("radio", { name: "Flat" }));
    await user.type(axis("Tokens").getByLabelText("Tokens per ticket"), "100000");
    await user.click(axis("Attempts").getByRole("radio", { name: "Off" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(sentBody(fetchMock)).toEqual({
      mode: "FLAT_MINUTES",
      flatMinutes: 30,
      perPointMinutes: null,
      tokens: { mode: "FLAT", flat: 100000 },
      attempts: { mode: "OFF" },
    });
    expect(await screen.findByText("Limits saved.")).toBeInTheDocument();
  });

  it("saves per point by hand values and shows them again on load", async () => {
    const fetchMock = stubFetch(Response.json({}));
    const { unmount } = render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(axis("Tokens").getByRole("radio", { name: "Per point by hand" }));
    await user.click(axis("Tokens").getByRole("button", { name: "Add row" }));
    await user.type(axis("Tokens").getByLabelText("Story points (row 1)"), "2");
    await user.type(axis("Tokens").getByLabelText("Tokens (row 1)"), "90000");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const body = sentBody(fetchMock);
    expect(body.tokens).toEqual({ mode: "PER_POINT_BY_HAND", byHand: { "2": 90000 } });
    unmount();

    render(<RunTimeBudgetSection tokens={body.tokens} />);
    expect(axis("Tokens").getByRole("radio", { name: "Per point by hand" })).toBeChecked();
    expect(axis("Tokens").getByLabelText("Story points (row 1)")).toHaveValue("2");
    expect(axis("Tokens").getByLabelText("Tokens (row 1)")).toHaveValue("90000");
  });

  it("maps time's stored modes onto the shared ones", () => {
    render(<RunTimeBudgetSection initial={{ mode: "PER_POINT", perPointMinutes: { 3: 45 } }} />);
    expect(axis("Time").getByRole("radio", { name: "Per point by hand" })).toBeChecked();
    expect(axis("Time").getByLabelText("Minutes (row 1)")).toHaveValue("45");
  });

  it("shows a saved flat value on load", () => {
    render(<RunTimeBudgetSection initial={{ mode: "FLAT_MINUTES", flatMinutes: 30 }} />);
    expect(axis("Time").getByRole("radio", { name: "Flat" })).toBeChecked();
    expect(axis("Time").getByLabelText("Minutes per ticket")).toHaveValue("30");
  });

  it("blocks the request and shows an inline error for an empty by-hand table", async () => {
    const fetchMock = stubFetch(Response.json({}));
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(axis("Attempts").getByRole("radio", { name: "Per point by hand" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Add at least one per-point value.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks flat values below 1", async () => {
    const fetchMock = stubFetch(Response.json({}));
    render(<RunTimeBudgetSection />);
    const user = userEvent.setup();

    await user.click(axis("Time").getByRole("radio", { name: "Flat" }));
    await user.type(axis("Time").getByLabelText("Minutes per ticket"), "0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText(/at least 1/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the API's field error next to the field", async () => {
    stubFetch(
      Response.json(
        { error: "Invalid run time budget.", errors: { "tokens.flat": "Too many for this plan." } },
        { status: 400 },
      ),
    );
    render(<RunTimeBudgetSection tokens={{ mode: "FLAT", flat: 5 }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Too many for this plan.")).toBeInTheDocument();
    expect(axis("Tokens").getByLabelText("Tokens per ticket")).toHaveAccessibleDescription("Too many for this plan.");
    expect(screen.queryByText("Limits saved.")).toBeNull();
  });
});
