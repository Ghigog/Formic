import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CallsView } from "./calls-view";

const guests = [
  { id: "assistant" as const, label: "Assistant" },
  { id: "sentinel:techops" as const, label: "TechOps" },
];

let saved: Record<string, unknown> | null;

beforeEach(() => {
  saved = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        saved = JSON.parse(init.body as string);
        return Response.json(
          { meeting: { id: "m1", projectId: "p", agenda: "", guests: [], lastRemindedFor: null, createdAt: new Date().toISOString(), ...saved } },
          { status: 201 },
        );
      }
      return Response.json({ meetings: [] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("CallsView", () => {
  it("opens the form with the slot's time, then shows the saved meeting in that slot", async () => {
    render(<CallsView guests={guests} />);
    const slot = (await screen.findAllByRole("button", { name: /10:00$/ }))[0]!;
    const label = slot.getAttribute("aria-label")!;
    await userEvent.click(slot);

    const form = screen.getByRole("form", { name: "New meeting" });
    expect(form.querySelector("time")).toHaveAttribute("dateTime", expect.stringMatching(/T/));
    await userEvent.type(screen.getByLabelText("Title"), "Review");
    await userEvent.click(screen.getByLabelText("Assistant"));
    await userEvent.selectOptions(screen.getByLabelText("Repeat"), "weekly");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(saved).toMatchObject({ title: "Review", guests: ["assistant"], repeat: "weekly" });
    expect(await screen.findAllByText("Review")).toHaveLength(2); // weekly, over two weeks
    expect(screen.queryByRole("button", { name: label })).toBeNull();
    expect(screen.queryByRole("form", { name: "New meeting" })).toBeNull();
  });

  it("offers the guests it is given", async () => {
    render(<CallsView guests={guests} />);
    await userEvent.click((await screen.findAllByRole("button", { name: /09:00$/ }))[0]!);
    expect(screen.getByLabelText("TechOps")).toBeInTheDocument();
  });
});
