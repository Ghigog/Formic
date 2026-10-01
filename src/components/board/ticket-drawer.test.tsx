import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { TicketDrawer } from "./ticket-drawer";
import { PlanSteps } from "@/components/ui/plan-steps";
import { makeCard } from "@/test/cards";
import type { FormicEvent } from "@/lib/domain/events";
import type { TicketView } from "@/lib/domain/ticket-view";
import type { AttachmentSummary } from "@/lib/domain/entities";
import { setViewportMatches } from "@/test/viewport";

const card = makeCard({
  id: "t-1",
  key: "T-1",
  title: "Export endpoint",
  status: "running",
  stage: 5,
  storyPoints: 5,
  fileScope: ["src/app/api/export"],
});

const VIEW: TicketView = {
  card,
  epic: { id: "e-1", key: "EPIC-1", title: "Board export" },
  description: [
    "**User story:** As a board owner, I'd like to export my board, so that I can report on it.",
    "",
    "### Context",
    "People track work in spreadsheets.",
    "",
    "### Requirements",
    "- Stream the CSV",
  ].join("\n"),
  acceptanceCriteria: ["Given a board, when I export it, then I get a CSV."],
  branchName: null,
  summary: null,
  dependsOn: [],
  handoff: [],
  plan: [
    { step: "Read the board model", status: "done" },
    { step: "Add the endpoint", status: "in_progress" },
    { step: "Test it", status: "pending" },
  ],
  canStop: false,
  activity: [{ seq: 1, at: "2026-09-23T16:00:00Z", kind: "thinking", text: "The model has a cards table." }],
};

afterEach(() => vi.unstubAllGlobals());

function open(view: TicketView = VIEW, attachments: AttachmentSummary[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/attachments")) return Response.json({ attachments });
      return Response.json(view);
    }),
  );
  const listeners = new Set<(e: FormicEvent, seq: number) => void>();
  const subscribe = (l: (e: FormicEvent, seq: number) => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const onOpenEpic = vi.fn();
  render(<TicketDrawer ticketId="t-1" onClose={() => {}} onOpenEpic={onOpenEpic} subscribe={subscribe} />);
  const send = (e: FormicEvent, seq: number) => act(() => listeners.forEach((l) => l(e, seq)));
  return { send, onOpenEpic };
}

describe("TicketDrawer work type", () => {
  const todoView = (workType: TicketView["card"]["workType"] = null): TicketView => ({
    ...VIEW,
    card: { ...card, status: "ready", workType },
  });

  it("offers Bug and Spike only while the ticket is in To Do", async () => {
    open();
    await screen.findByText("Export endpoint");
    expect(screen.queryByRole("group", { name: "Work type" })).not.toBeInTheDocument();
  });

  it("presses Bug by sending the PATCH, and sends null when it is pressed again", async () => {
    const { fetched } = openTodo(todoView("bug"));
    const group = await screen.findByRole("group", { name: "Work type" });
    const bug = within(group).getByRole("button", { name: "bug" });
    expect(bug).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Tagged as bug · −5 points/)).toBeInTheDocument();
    fireEvent.click(bug);
    await vi.waitFor(() =>
      expect(fetched).toContainEqual(["/api/tickets/t-1", "PATCH", JSON.stringify({ workType: null })]),
    );
    fireEvent.click(within(group).getByRole("button", { name: "spike" }));
    await vi.waitFor(() =>
      expect(fetched).toContainEqual(["/api/tickets/t-1", "PATCH", JSON.stringify({ workType: "spike" })]),
    );
  });
});

function openTodo(view: TicketView) {
  const fetched: Array<[string, string, string | undefined]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "PATCH") {
        fetched.push([url, "PATCH", init.body as string]);
        return Response.json({ ok: true });
      }
      if (url.includes("/api/attachments")) return Response.json({ attachments: [] });
      return Response.json(view);
    }),
  );
  render(
    <TicketDrawer ticketId="t-1" onClose={() => {}} onOpenEpic={() => {}} subscribe={() => () => {}} />,
  );
  return { fetched };
}

describe("TicketDrawer", () => {
  it("shows the story points and no T-shirt size", async () => {
    open();
    expect(await screen.findByTitle("5 story points")).toBeInTheDocument();
    expect(screen.queryByTitle("Ticket size")).not.toBeInTheDocument();
  });

  it("on mobile shows one full-width pane under the tabs, and switching swaps it", async () => {
    setViewportMatches(false);
    open();
    const ticket = await screen.findByRole("region", { name: "Ticket" });
    expect(screen.queryByRole("region", { name: "Agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    // The pane is the only child of the content area, so it takes the whole row.
    expect(ticket.parentElement?.children).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    const agent = await screen.findByRole("region", { name: "Agent" });
    expect(screen.queryByRole("region", { name: "Ticket" })).not.toBeInTheDocument();
    expect(agent.parentElement?.children).toHaveLength(1);
  });

  it("on desktop keeps both panes side by side with a divider", async () => {
    setViewportMatches(true);
    open();
    expect(await screen.findByRole("region", { name: "Ticket" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize the panes" })).toBeInTheDocument();
  });

  it("shows the ticket as it was written, with its story points", async () => {
    open();
    const ticket = await screen.findByRole("region", { name: "Ticket" });
    expect(within(ticket).getByText("User story:")).toBeInTheDocument();
    expect(within(ticket).getByText("Context")).toBeInTheDocument();
    expect(within(ticket).getByText("Stream the CSV")).toBeInTheDocument();
    expect(within(ticket).getByText(/I get a CSV/)).toBeInTheDocument();
    expect(screen.getByTitle("5 story points")).toHaveTextContent("5 pt");
    expect(screen.getByRole("list", { name: "Ticket progress" })).toBeInTheDocument();
  });

  it("shows the agent's plan and thinking, and follows them live", async () => {
    setViewportMatches(true);
    const { send } = open();
    const agent = await screen.findByRole("region", { name: "Agent" });
    const plan = within(agent).getByRole("list", { name: "Agent's plan" });
    expect(within(plan).getByText("Add the endpoint")).toHaveTextContent("in progress");
    expect(within(agent).getByText("The model has a cards table.")).toBeInTheDocument();

    send(
      { type: "run.thought", runId: "r", ticketId: "t-1", kind: "text", text: "Writing the handler now." },
      2,
    );
    send({ type: "run.thought", runId: "r", ticketId: "other", kind: "text", text: "Not this ticket." }, 3);
    send(
      {
        type: "ticket.plan",
        ticketId: "t-1",
        steps: [
          { step: "Read the board model", status: "done" },
          { step: "Add the endpoint", status: "done" },
          { step: "Test it", status: "in_progress" },
        ],
      },
      4,
    );

    expect(within(agent).getByText("Writing the handler now.")).toBeInTheDocument();
    expect(within(agent).queryByText("Not this ticket.")).not.toBeInTheDocument();
    expect(within(plan).getByText("Test it")).toHaveTextContent("in progress");
  });

  it("leads back to its Epic", async () => {
    const { onOpenEpic } = open();
    (await screen.findByRole("button", { name: /EPIC-1: Board export/ })).click();
    expect(onOpenEpic).toHaveBeenCalledWith("e-1");
  });

  it("says nothing about a reroute for a ticket that was never moved", async () => {
    open();
    await screen.findByRole("region", { name: "Ticket" });
    expect(screen.queryByText(/Moved from/)).not.toBeInTheDocument();
  });

  it("shows where a rerouted ticket came from and why, so it survives after the toast is gone", async () => {
    const rerouted: TicketView = {
      ...VIEW,
      card: { ...VIEW.card, rerouteFrom: "todo", rerouteReason: "Too big for one ticket; needs a PRD." },
    };
    open(rerouted);
    await screen.findByRole("region", { name: "Ticket" });
    expect(screen.getByText("Moved from To Do: Too big for one ticket; needs a PRD.")).toBeInTheDocument();
  });

  it("shows an image thumbnail and a downloadable file chip for its attachments", async () => {
    const attachments: AttachmentSummary[] = [
      { id: "a-1", filename: "mock.png", mimeType: "image/png", kind: "image", size: 2048, url: "/api/attachments/a-1" },
      { id: "a-2", filename: "notes.txt", mimeType: "text/plain", kind: "file", size: 512, url: "/api/attachments/a-2" },
    ];
    open(VIEW, attachments);
    const ticket = await screen.findByRole("region", { name: "Ticket" });

    const thumb = await within(ticket).findByRole("button", { name: "Enlarge mock.png" });
    expect(within(ticket).getByText("notes.txt")).toBeInTheDocument();
    expect(within(ticket).getByText("512 B")).toBeInTheDocument();
    expect(within(ticket).getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/attachments/a-2",
    );

    thumb.click();
    const lightbox = await screen.findByRole("dialog", { name: "mock.png" });
    expect(within(lightbox).getByAltText("mock.png")).toHaveAttribute("src", "/api/attachments/a-1");
  });

  it("links the setup pull request a blocked ticket's reason names, so it can be clicked through", async () => {
    const url = "https://github.com/acme/widgets/pull/7";
    open({
      ...VIEW,
      card: makeCard({
        id: "t-1",
        key: "T-1",
        title: "Export endpoint",
        status: "blocked",
        blockedReason: `Claude Code runs in this repository's GitHub Actions. Merge the setup pull request once (${url}), then try again.`,
      }),
    });

    const link = await screen.findByRole("link", { name: url });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    // The sentence around the link is still a sentence, under "This needs you."
    expect(screen.getByText(/Merge the setup pull request once/)).toBeInTheDocument();
    expect(screen.getByText(/This needs you\./)).toBeInTheDocument();
  });

  it("does the same for a reason that is a wait, not a stall, such as a dependency", async () => {
    const url = "https://github.com/acme/widgets/pull/7";
    open({
      ...VIEW,
      card: makeCard({
        id: "t-1",
        key: "T-1",
        title: "Export endpoint",
        status: "waiting",
        blockedReason: `Waiting on the setup pull request (${url}) before it can start.`,
      }),
    });

    const link = await screen.findByRole("link", { name: url });
    expect(link).toHaveAttribute("href", url);
  });

  it("shows nothing where a ticket has no attachments", async () => {
    open();
    await screen.findByRole("region", { name: "Ticket" });
    expect(screen.queryByText("Attachments")).not.toBeInTheDocument();
  });
});

describe("PlanSteps", () => {
  it("marches ants from the current step while the agent works, and only then", () => {
    const steps = VIEW.plan;
    const { container, rerender } = render(<PlanSteps steps={steps} working />);
    expect(container.querySelectorAll(".ant-trail-vertical")).toHaveLength(1);
    rerender(<PlanSteps steps={steps} working={false} />);
    expect(container.querySelectorAll(".ant-trail-vertical")).toHaveLength(0);
  });
});
