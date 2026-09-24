import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { TicketDrawer } from "./ticket-drawer";
import { PlanSteps } from "@/components/ui/plan-steps";
import { makeCard } from "@/test/cards";
import type { FormicEvent } from "@/lib/domain/events";
import type { TicketView } from "@/lib/domain/ticket-view";

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

function open() {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(VIEW)));
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

describe("TicketDrawer", () => {
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
