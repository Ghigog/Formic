import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PmWakeLimitsFields } from "./pm-wake-section";

afterEach(() => vi.unstubAllGlobals());

function setup(ok = true) {
  const fetchMock = vi.fn(async () => (ok ? Response.json({}) : new Response("{}", { status: 500 })));
  vi.stubGlobal("fetch", fetchMock);
  render(<PmWakeLimitsFields projectId="proj" limits={{ fixCap: 2, perHour: 6, perDay: 20 }} />);
  return fetchMock;
}

describe("PM wake-up limits", () => {
  it("shows the limits as they apply now", () => {
    setup();
    expect(screen.getByRole("spinbutton", { name: "Fix attempts per stuck ticket" })).toHaveValue(2);
    expect(screen.getByRole("spinbutton", { name: "Wake-ups per hour" })).toHaveValue(6);
    expect(screen.getByRole("spinbutton", { name: "Wake-ups per day (UTC)" })).toHaveValue(20);
  });

  it("saves a changed limit when it loses focus, and nothing when it is unchanged", async () => {
    const fetchMock = setup();
    const day = screen.getByRole("spinbutton", { name: "Wake-ups per day (UTC)" });
    await userEvent.click(day);
    await userEvent.tab();
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.clear(day);
    await userEvent.type(day, "40");
    await userEvent.tab();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ projectId: "proj", pmWakeLimits: { perDay: 40 } }) }),
    );
  });

  it("refuses a number out of range without saving", async () => {
    const fetchMock = setup();
    const hour = screen.getByRole("spinbutton", { name: "Wake-ups per hour" });
    await userEvent.clear(hour);
    await userEvent.type(hour, "99");
    await userEvent.tab();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Pick a whole number from 0 to 60.")).toBeInTheDocument();
  });

  it("says when a save failed", async () => {
    setup(false);
    const cap = screen.getByRole("spinbutton", { name: "Fix attempts per stuck ticket" });
    await userEvent.clear(cap);
    await userEvent.type(cap, "3");
    await userEvent.tab();
    expect(await screen.findByText("That did not save. Try again.")).toBeInTheDocument();
  });
});
