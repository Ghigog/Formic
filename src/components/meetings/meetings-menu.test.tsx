import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider, useColony } from "@/components/colony/colony";
import { SoundEngine } from "@/components/colony/sound";
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
  // jsdom has no Web Animations.
  Element.prototype.animate = vi.fn() as never;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
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
    expect(screen.getAllByRole("button", { name: "Join now" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No meetings yet. Let's plan one.")).toBeInTheDocument();
  });

  describe("entrance", () => {
    const at = (h: number) => {
      const d = tomorrow();
      d.setHours(h);
      return d;
    };
    const meeting = (id: string, title: string, d: Date, repeat = "none") => ({
      id, projectId: "p", title, startsAt: d.toISOString(), agenda: "", guests: [], repeat, lastRemindedFor: null, createdAt: d.toISOString(),
    });
    const played = (play: { mock: { calls: unknown[][] } }) => play.mock.calls.map((c) => c[0]).filter((n) => n !== "pickup");

    it("drops the page, plops each meeting in time order with its pitch, then rings Up next", async () => {
      stored = [meeting("a", "Sprint planning", at(16)), meeting("b", "Standup", at(9), "weekly")];
      const play = vi.spyOn(SoundEngine.prototype, "play");
      mount();
      await userEvent.click(screen.getByText("meetings chip"));
      await waitFor(() => expect(played(play)).toContain("ring"), { timeout: 4000 });
      const names = played(play);
      expect(names[0]).toBe("drop");
      expect(names.filter((n) => n === "plop")).toHaveLength(3);
      const pitches = play.mock.calls.filter((c) => c[0] === "plop").map((c) => c[1] as number);
      expect(pitches[0]).toBeGreaterThan(pitches[1]!); // Standup at 09:00 before Sprint planning at 16:00
      expect(names.lastIndexOf("plop")).toBeLessThan(names.indexOf("ring"));
      play.mockRestore();
    });

    it("lands one plop on today when there are no meetings", async () => {
      const play = vi.spyOn(SoundEngine.prototype, "play");
      mount();
      await userEvent.click(screen.getByText("meetings chip"));
      await waitFor(() => expect(played(play)).toContain("plop"), { timeout: 4000 });
      expect(played(play).filter((n) => n === "plop")).toHaveLength(1);
      expect(played(play)).not.toContain("ring");
      play.mockRestore();
    });

    it("with reduced motion shows everything at once and only rings Up next", async () => {
      vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
      stored = [meeting("a", "Standup", at(9))];
      const play = vi.spyOn(SoundEngine.prototype, "play");
      mount();
      await userEvent.click(screen.getByText("meetings chip"));
      await waitFor(() => expect(played(play)).toEqual(["ring"]));
      expect(Element.prototype.animate).not.toHaveBeenCalled();
      play.mockRestore();
    });
  });

  it("opens on the meeting a reminder links to", async () => {
    const soon = tomorrow();
    stored = [{ id: "m1", projectId: "p", title: "Retro", startsAt: soon.toISOString(), agenda: "", guests: [], repeat: "none", lastRemindedFor: null, createdAt: soon.toISOString() }];
    window.history.pushState(null, "", "/?meeting=m1");
    mount();
    expect(await screen.findByRole("region", { name: "Retro" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
