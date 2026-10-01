import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenewalDaySection } from "./renewal-day-section";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("RenewalDaySection", () => {
  it("shows the stored day", () => {
    render(<RenewalDaySection initial={{ day: 5, timezone: "Europe/Paris" }} />);
    expect(screen.getByLabelText("Renewal day")).toHaveValue("5");
  });

  it("sends the day with the browser timezone", async () => {
    const fetchMock = stubFetch(Response.json({ renewalDay: 5, timezone: "UTC" }));
    render(<RenewalDaySection />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Renewal day"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const init = fetchMock.mock.calls[0]![1];
    expect(JSON.parse(init.body as string)).toEqual({
      renewalDay: 5,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Renewal day saved.");
  });

  it("sends null when the field is cleared", async () => {
    const fetchMock = stubFetch(Response.json({ renewalDay: null, timezone: null }));
    render(<RenewalDaySection initial={{ day: 5, timezone: "UTC" }} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Renewal day"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const init = fetchMock.mock.calls[0]![1];
    expect(JSON.parse(init.body as string).renewalDay).toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent("Renewal day removed.");
  });

  it("rejects 32 with a message and does not save", async () => {
    const fetchMock = stubFetch(Response.json({}));
    render(<RenewalDaySection />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Renewal day"), "32");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 to 31");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
