import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider, useColony } from "@/components/colony/colony";
import { MeetingsMenu } from "./meetings-menu";

function Chip() {
  const c = useColony();
  return <button onClick={() => c?.setMeetingsOpen(!c.meetingsOpen)}>meetings chip</button>;
}

/** Tomorrow at 10:00, a slot the calendar shows whatever time the test runs. */
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
};
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

let stored: Record<string, unknown>[];
let saved: Record<string, unknown> | null;

beforeEach(() => {
  stored = [];
  saved = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        saved = JSON.parse(init.body as string);
        stored.push({ id: "m1", projectId: "p", lastRemindedFor: null, createdAt: new Date().toISOString(), ...saved });
        return Response.json({ meeting: stored[0] }, { status: 201 });
      }
      if (init?.method === "DELETE") {
        stored = [];
        return new Response(null, { status: 204 });
      }
      return Response.json({ meetings: stored });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const mount = () =>
  render(
    <ColonyProvider storageKey="colony-test-meetings" cards={[]} extras={{}}>
      <Chip />
      <MeetingsMenu repoName="formic" />
    </ColonyProvider>,
  );

describe("MeetingsMenu", () => {
  it("opens from the chip with the empty state and New meeting, and Esc closes it", async () => {
    mount();
    expect(screen.queryByRole("region", { name: "Meetings" })).toBeNull();
    await userEvent.click(screen.getByText("meetings chip"));
    expect(screen.getByRole("region", { name: "Meetings" })).toBeInTheDocument();
    expect(screen.getByText("Ceremonies · formic")).toBeInTheDocument();
    expect(screen.getByText("No meetings yet. Let's plan one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Meetings" })).toBeNull();
  });

  it("saves a weekly Sprint planning with a starter agenda, then shows it as Up next and on both weeks", async () => {
    mount();
    await userEvent.click(screen.getByText("meetings chip"));
    await userEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: localInput(tomorrow()) } });
    await userEvent.click(screen.getByRole("button", { name: "Sprint planning" }));
    await userEvent.selectOptions(screen.getByLabelText("Repeat"), "weekly");
    await userEvent.click(screen.getByLabelText("PM"));
    await userEvent.click(screen.getByLabelText("Coder"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(saved).toMatchObject({ title: "Sprint planning", repeat: "weekly", guests: ["assistant", "coder"] });
    expect(String(saved!.agenda)).toContain("Pick the tickets");
    expect(await screen.findByRole("region", { name: "Up next" })).toHaveTextContent("Sprint planning");
    expect(screen.getAllByTitle("Sprint planning").length).toBeGreaterThanOrEqual(2);
  });

  it("opens an occurrence's card with Join now, Edit and Delete, and Delete removes it", async () => {
    const soon = tomorrow();
    stored = [{ id: "m1", projectId: "p", title: "Retro", startsAt: soon.toISOString(), agenda: "", guests: [], repeat: "none", lastRemindedFor: null, createdAt: soon.toISOString() }];
    mount();
    await userEvent.click(screen.getByText("meetings chip"));
    await userEvent.click((await screen.findAllByTitle("Retro"))[0]!);
    const card = screen.getByRole("region", { name: "Retro" });
    expect(card).toHaveTextContent("Join now");
    expect(screen.getAllByRole("link", { name: "Join now" })[0]).toHaveAttribute("href", "/calls/m1");
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No meetings yet. Let's plan one.")).toBeInTheDocument();
  });
});
